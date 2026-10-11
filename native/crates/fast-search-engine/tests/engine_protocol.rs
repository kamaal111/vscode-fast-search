use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    thread,
    time::Duration,
};
use tempfile::TempDir;

struct Engine {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Engine {
    fn start() -> Self {
        Self::start_with_env(&[])
    }
    fn start_with_env(env: &[(&str, &std::path::Path)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_fast-search-engine"))
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("engine starts");
        let input = child.stdin.take().expect("stdin");
        let output = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            input,
            output,
        }
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input, "{value}").expect("request writes");
        self.input.flush().expect("request flushes");
    }
    fn next(&mut self) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).expect("response reads");
        serde_json::from_str(&line).expect("valid response")
    }
    fn until(&mut self, kind: &str) -> Value {
        loop {
            let value = self.next();
            if value["type"] == kind {
                return value;
            }
        }
    }
    fn wait_for_file(&mut self, query: &str) -> Value {
        for attempt in 0..300 {
            self.send(json!({"type":"fileSearch","version":1,"requestId":format!("refresh-{attempt}"),"query":query,"maxResults":10}));
            let response = self.until("fileResults");
            if response["results"]
                .as_array()
                .is_some_and(|results| !results.is_empty())
            {
                return response;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("filesystem event was not reflected in the searchable snapshot");
    }
    fn wait_for_absent(&mut self, query: &str) {
        for attempt in 0..300 {
            self.send(json!({"type":"fileSearch","version":1,"requestId":format!("absent-{attempt}"),"query":query,"maxResults":10}));
            let response = self.until("fileResults");
            if response["results"].as_array().is_some_and(Vec::is_empty) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("removed file remained in the searchable snapshot");
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[test]
fn flushes_shutdown_response_before_exiting() {
    for attempt in 0..50 {
        let mut engine = Engine::start();
        let request_id = format!("shutdown-{attempt}");
        engine.send(json!({"type":"shutdown","version":1,"requestId":request_id}));
        assert_eq!(engine.until("diagnostics")["requestId"], request_id);
        assert!(engine.child.wait().expect("engine exits").success());
    }
}

#[test]
fn indexes_searches_refreshes_overlays_and_validates_protocol() {
    let first = TempDir::new().expect("first root");
    let second = TempDir::new().expect("second root");
    fs::create_dir(first.path().join("src")).expect("src directory");
    fs::write(
        first.path().join("src/SearchModel.swift"),
        "let greeting = \"Hello Search\"\nlet lower = \"hello search\"\nBEGIN\nmiddle\nEND\nwhole needle needles\n😀 café target\n",
    )
    .expect("source file");
    fs::write(first.path().join("ignored.txt"), "secret phrase").expect("ignored file");
    fs::write(first.path().join(".gitignore"), "ignored.txt\n").expect("ignore file");
    fs::write(second.path().join("README.md"), "hello documentation\n").expect("second file");
    fs::write(first.path().join("scoped.tmp"), "first scoped").expect("first scoped file");
    fs::write(second.path().join("scoped.tmp"), "second scoped").expect("second scoped file");
    fs::write(first.path().join("latin1.txt"), b"caf\xe9 needle\r\n").expect("encoded file");
    fs::write(first.path().join("spaced file.txt"), "disk spaced content").expect("spaced file");
    let mut engine = Engine::start();

    engine.send(json!({"type":"initialize","version":1,"requestId":"init","roots":[{"id":"one","path":first.path()},{"id":"two","path":second.path()}],"configuration":{"excludes":[],"rootExcludes":{"one":["scoped.tmp"]},"useIgnoreFiles":true,"followSymlinks":false}}));
    let ready = engine.until("indexReady");
    assert_eq!(ready["requestId"], "init");
    assert_eq!(ready["fileCount"], 6);

    engine.send(json!({"type":"fileSearch","version":1,"requestId":"scoped","query":"scoped tmp","maxResults":100}));
    let scoped = engine.until("fileResults");
    assert_eq!(scoped["results"].as_array().map(Vec::len), Some(1));
    assert_eq!(scoped["results"][0]["rootId"], "two");

    engine.send(json!({"type":"fileSearch","version":1,"requestId":"encoded-uri","query":"spaced file","maxResults":100}));
    let encoded_uri = engine.until("fileResults");
    assert!(
        encoded_uri["results"][0]["uri"]
            .as_str()
            .is_some_and(|uri| uri.ends_with("spaced%20file.txt"))
    );
    let spaced_uri = encoded_uri["results"][0]["uri"]
        .as_str()
        .expect("encoded URI")
        .to_owned();
    engine.send(json!({"type":"textSearch","version":1,"requestId":"spaced-overlay","query":"overlay for spaced path","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"maxResults":20},"overlays":[{"uri":spaced_uri,"text":"overlay for spaced path\n","untitled":false}]}));
    assert_eq!(
        engine.until("textResultBatch")["results"][0]["preview"],
        "overlay for spaced path"
    );
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"fileSearch","version":1,"requestId":"files","query":"srch mdl:7:2","maxResults":100}));
    let files = engine.until("fileResults");
    assert_eq!(files["results"][0]["relativePath"], "src/SearchModel.swift");
    assert_eq!(files["results"][0]["line"], 7);
    assert_eq!(files["results"][0]["column"], 2);

    fs::write(first.path().join("NewFile.swift"), "disk is stale\n").expect("new file");
    assert_eq!(
        engine.wait_for_file("newfile")["results"][0]["relativePath"],
        "NewFile.swift"
    );
    fs::create_dir(first.path().join("generated")).expect("new directory");
    fs::rename(
        first.path().join("NewFile.swift"),
        first.path().join("generated/RenamedFile.swift"),
    )
    .expect("rename file");
    assert_eq!(
        engine.wait_for_file("renamedfile")["results"][0]["relativePath"],
        "generated/RenamedFile.swift"
    );
    engine.wait_for_absent("newfile");
    fs::remove_file(first.path().join("generated/RenamedFile.swift")).expect("delete file");
    engine.wait_for_absent("renamedfile");
    fs::write(
        first.path().join("generated/RenamedFile.swift"),
        "disk is stale\n",
    )
    .expect("restore overlay target");
    assert_eq!(
        engine.wait_for_file("renamedfile")["results"][0]["relativePath"],
        "generated/RenamedFile.swift"
    );

    let uri = format!(
        "file://{}",
        first.path().join("generated/RenamedFile.swift").display()
    );
    engine.send(json!({"type":"textSearch","version":1,"requestId":"text","query":"overlay wins","options":{"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"maxResults":20},"overlays":[{"uri":uri,"text":"overlay wins here\n","untitled":false}]}));
    let batch = engine.until("textResultBatch");
    assert_eq!(batch["results"][0]["preview"], "overlay wins here");
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"regex-case","query":"Hello\\s+Search","options":{"encoding":null,"regex":true,"caseSensitive":true,"smartCase":false,"wholeWord":false,"multiline":false,"includes":["src/**"],"excludes":[],"maxResults":20},"overlays":[]}));
    assert_eq!(engine.until("textResultBatch")["results"][0]["line"], 0);
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"whole","query":"needle","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":true,"multiline":false,"includes":["src/**"],"excludes":[],"maxResults":20},"overlays":[]}));
    assert_eq!(
        engine.until("textResultBatch")["results"][0]["preview"],
        "whole needle needles"
    );
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"multiline","query":"BEGIN.*END","options":{"encoding":null,"regex":true,"caseSensitive":true,"smartCase":false,"wholeWord":false,"multiline":true,"includes":[],"excludes":[],"maxResults":20},"overlays":[]}));
    let multiline = engine.until("textResultBatch");
    assert_eq!(multiline["results"][0]["line"], 2);
    assert_eq!(multiline["results"][0]["endLine"], 4);
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"unicode-range","query":"target","options":{"encoding":null,"regex":false,"caseSensitive":true,"smartCase":false,"wholeWord":false,"multiline":false,"includes":["src/**"],"excludes":[],"maxResults":20},"overlays":[]}));
    let unicode = engine.until("textResultBatch");
    assert_eq!(unicode["results"][0]["line"], 6);
    assert_eq!(unicode["results"][0]["startColumn"], 8);
    assert_eq!(unicode["results"][0]["endColumn"], 14);
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"limit","query":"hello search","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":false,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"maxResults":1},"overlays":[]}));
    assert_eq!(
        engine.until("textResultBatch")["results"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    let limited = engine.until("textSearchComplete");
    assert_eq!(limited["resultCount"], 1);
    assert_eq!(limited["limitHit"], true);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"untitled","query":"only in an untitled editor","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"maxResults":20},"overlays":[{"uri":"untitled:Untitled-1","text":"only in an untitled editor\n","untitled":true}]}));
    let untitled = engine.until("textResultBatch");
    assert_eq!(untitled["results"][0]["uri"], "untitled:Untitled-1");
    assert_eq!(untitled["results"][0]["rootId"], "untitled");
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"ignored","query":"secret phrase","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"maxResults":20},"overlays":[]}));
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 0);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"encoding","query":"café needle","options":{"encoding":"windows-1252","regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"maxResults":20},"overlays":[]}));
    assert_eq!(
        engine.until("textResultBatch")["results"][0]["preview"],
        "café needle"
    );
    assert_eq!(engine.until("textSearchComplete")["resultCount"], 1);

    writeln!(engine.input, "not-json").expect("malformed request writes");
    engine.input.flush().expect("malformed request flushes");
    assert_eq!(engine.until("requestError")["code"], "invalidMessage");
    engine.send(json!({"type":"shutdown","version":1,"requestId":"bye"}));
    assert_eq!(engine.until("diagnostics")["requestId"], "bye");
}

#[test]
fn publishes_searchable_partial_snapshots_during_initial_indexing() {
    let first = TempDir::new().expect("first root");
    let slow = TempDir::new().expect("slow root");
    fs::write(first.path().join("AlreadyVisible.swift"), "visible").expect("first file");
    for index in 0..4_000 {
        fs::write(
            slow.path().join(format!("Generated{index:04}.txt")),
            "generated",
        )
        .expect("generated fixture");
    }
    let mut engine = Engine::start();
    engine.send(json!({"type":"initialize","version":1,"requestId":"partial-init","roots":[{"id":"first","path":first.path()},{"id":"slow","path":slow.path()}],"configuration":{"excludes":[],"useIgnoreFiles":true,"followSymlinks":false}}));
    let progress = engine.until("indexProgress");
    assert_eq!(progress["rootId"], "first");
    assert_eq!(progress["filesIndexed"], 1);
    engine.send(json!({"type":"fileSearch","version":1,"requestId":"partial-search","query":"already visible","maxResults":10}));
    let results = engine.until("fileResults");
    assert_eq!(results["requestId"], "partial-search");
    assert_eq!(results["partial"], true);
    assert_eq!(
        results["results"][0]["relativePath"],
        "AlreadyVisible.swift"
    );
    assert_eq!(engine.until("indexReady")["fileCount"], 4_001);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"survives-stale-cancel","query":"generated","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"maxResults":4_000},"overlays":[]}));
    engine.send(json!({"type":"cancel","version":1,"requestId":"stale-cancel","targetRequestId":"an-old-request"}));
    let complete = engine.until("textSearchComplete");
    assert_eq!(complete["requestId"], "survives-stale-cancel");
    assert_eq!(complete["cancelled"], false);
    assert_eq!(complete["resultCount"], 4_000);

    engine.send(json!({"type":"textSearch","version":1,"requestId":"cancel-me","query":"absent value","options":{"encoding":null,"regex":false,"caseSensitive":false,"smartCase":true,"wholeWord":false,"multiline":false,"includes":[],"excludes":[],"maxResults":4_000},"overlays":[]}));
    engine.send(json!({"type":"cancel","version":1,"requestId":"real-cancel","targetRequestId":"cancel-me"}));
    let cancelled = engine.until("textSearchComplete");
    assert_eq!(cancelled["requestId"], "cancel-me");
    assert_eq!(cancelled["cancelled"], true);
}

fn assert_search_paths(engine: &mut Engine, configuration: Value, roots: Value, expected: &[&str]) {
    engine.send(json!({"type":"reconfigure", "version":1, "requestId":"settings", "roots":roots, "configuration":configuration}));
    engine.until("indexReady");
    engine.send(json!({"type":"fileSearch", "version":1, "requestId":"paths", "query":"", "maxResults":100}));
    let response = engine.until("fileResults");
    let mut paths: Vec<_> = response["results"]
        .as_array()
        .expect("file matches")
        .iter()
        .map(|value| value["relativePath"].as_str().expect("relative path"))
        .collect();
    paths.sort_unstable();
    assert_eq!(paths, expected);
    engine.send(json!({"type":"textSearch", "version":1, "requestId":"content", "query":"fixture phrase", "options":{"maxResults":100}, "overlays":[]}));
    assert_eq!(
        engine.until("textSearchComplete")["resultCount"],
        expected.len()
    );
}

#[test]
fn applies_folder_and_sibling_exclusions_to_file_and_text_search() {
    let root = TempDir::new().expect("root");
    fs::create_dir_all(root.path().join("generated/nested")).expect("generated directory");
    fs::create_dir(root.path().join("src")).expect("source directory");
    for name in [
        "generated/nested/data.txt",
        "src/app.js",
        "src/app.ts",
        "src/standalone.js",
        "visible.txt",
    ] {
        fs::write(root.path().join(name), "fixture phrase").expect("fixture");
    }
    let roots = json!([{"id":"one", "path":root.path()}]);
    let mut engine = Engine::start();
    assert_search_paths(
        &mut engine,
        json!({"rootExcludes":{"one":["generated", {"pattern":"**/*.js", "when":"$(basename).ts"}]}}),
        roots.clone(),
        &["src/app.ts", "src/standalone.js", "visible.txt"],
    );
    assert_search_paths(
        &mut engine,
        json!({"rootExcludes":{"one":["generated", {"pattern":"src/*.js", "when":"../src/$(basename).ts"}]}}),
        roots.clone(),
        &[
            "src/app.js",
            "src/app.ts",
            "src/standalone.js",
            "visible.txt",
        ],
    );
    fs::remove_file(root.path().join("src/app.ts")).expect("remove sibling");
    assert_search_paths(
        &mut engine,
        json!({"rootExcludes":{"one":["generated", {"pattern":"**/*.js", "when":"$(basename).ts"}]}}),
        roots,
        &["src/app.js", "src/standalone.js", "visible.txt"],
    );
}

#[test]
fn scopes_exclusions_and_ignore_flags_to_each_workspace_root() {
    let one = TempDir::new().expect("first root");
    let two = TempDir::new().expect("second root");
    fs::write(one.path().join("scoped.txt"), "fixture phrase").expect("first scoped");
    fs::write(two.path().join("scoped.txt"), "fixture phrase").expect("second scoped");
    fs::write(one.path().join(".gitignore"), "local.txt\n").expect("first ignore");
    fs::write(two.path().join(".gitignore"), "local.txt\n").expect("second ignore");
    fs::write(one.path().join("local.txt"), "fixture phrase").expect("first local");
    fs::write(two.path().join("local.txt"), "fixture phrase").expect("second local");
    let roots = json!([{"id":"one", "path":one.path()}, {"id":"two", "path":two.path()}]);
    let configuration = json!({"rootExcludes":{"one":["scoped.txt"], "two":[".gitignore"]}, "useIgnoreFilesByRoot":{"one":true, "two":false}, "excludes":[".gitignore"]});
    let mut engine = Engine::start();
    assert_search_paths(
        &mut engine,
        configuration,
        roots,
        &["local.txt", "scoped.txt"],
    );
}

#[test]
fn controls_local_global_and_parent_ignore_files_independently() {
    let parent = TempDir::new().expect("parent");
    let config = TempDir::new().expect("git configuration");
    let root = parent.path().join("workspace");
    fs::create_dir(&root).expect("workspace");
    fs::write(parent.path().join(".gitignore"), "parent.txt\n").expect("parent ignore");
    fs::write(root.join(".gitignore"), "local.txt\n").expect("local ignore");
    for name in ["parent.txt", "global.txt", "local.txt", "visible.txt"] {
        fs::write(root.join(name), "fixture phrase").expect("fixture");
    }
    let global_ignore = config.path().join("ignore");
    let global_config = config.path().join("config");
    fs::write(&global_ignore, "global.txt\n").expect("global ignore");
    fs::write(
        &global_config,
        format!("[core]\nexcludesFile = {}\n", global_ignore.display()),
    )
    .expect("global configuration");
    let mut engine = Engine::start_with_env(&[
        ("GIT_CONFIG_GLOBAL", &global_config),
        ("GIT_CONFIG_SYSTEM", &global_config),
        ("XDG_CONFIG_HOME", config.path()),
    ]);
    let roots = json!([{"id":"one", "path":root}]);
    assert_search_paths(
        &mut engine,
        json!({"excludes":[".gitignore"]}),
        roots.clone(),
        &["global.txt", "parent.txt", "visible.txt"],
    );
    assert_search_paths(
        &mut engine,
        json!({"excludes":[".gitignore"], "useGlobalIgnoreFilesByRoot":{"one":true}}),
        roots.clone(),
        &["parent.txt", "visible.txt"],
    );
    assert_search_paths(
        &mut engine,
        json!({"excludes":[".gitignore"], "useParentIgnoreFilesByRoot":{"one":true}}),
        roots.clone(),
        &["global.txt", "visible.txt"],
    );
    assert_search_paths(
        &mut engine,
        json!({"excludes":[".gitignore"], "useGlobalIgnoreFiles":true, "useParentIgnoreFiles":true}),
        roots.clone(),
        &["visible.txt"],
    );
    assert_search_paths(
        &mut engine,
        json!({"excludes":[".gitignore"], "useIgnoreFilesByRoot":{"one":false}, "useGlobalIgnoreFiles":true, "useParentIgnoreFiles":true}),
        roots,
        &["global.txt", "local.txt", "parent.txt", "visible.txt"],
    );
}

#[test]
fn keeps_single_star_exclusions_within_a_path_segment() {
    let root = TempDir::new().expect("root");
    fs::create_dir_all(root.path().join("src/nested")).expect("source directory");
    fs::create_dir(root.path().join("generated")).expect("generated directory");
    fs::write(root.path().join("src/app.js"), "fixture phrase").expect("direct source");
    fs::write(root.path().join("src/nested/app.js"), "fixture phrase").expect("nested source");
    fs::write(root.path().join("generated/data.txt"), "fixture phrase").expect("generated source");
    let roots = json!([{"id":"one", "path":root.path()}]);
    let mut engine = Engine::start();
    assert_search_paths(
        &mut engine,
        json!({"rootExcludes":{"one":["src/*.js", "generated/"]}}),
        roots,
        &["src/nested/app.js"],
    );
}
