use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfiguration {
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default)]
    pub root_excludes: HashMap<String, Vec<String>>,
    #[serde(default = "default_true")]
    pub use_ignore_files: bool,
    #[serde(default)]
    pub use_ignore_files_by_root: HashMap<String, bool>,
    #[serde(default)]
    pub follow_symlinks: bool,
    #[serde(default)]
    pub follow_symlinks_by_root: HashMap<String, bool>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveEditor {
    pub uri: String,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOverlay {
    pub uri: String,
    pub text: String,
    pub encoding: Option<String>,
    pub untitled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchOptions {
    pub encoding: Option<String>,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub smart_case: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub multiline: bool,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default = "default_true")]
    pub use_excludes: bool,
    #[serde(default = "default_limit")]
    pub max_results: usize,
}

fn default_limit() -> usize {
    10_000
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Initialize {
        version: u32,
        request_id: String,
        roots: Vec<WorkspaceRoot>,
        configuration: SearchConfiguration,
    },
    Reconfigure {
        version: u32,
        request_id: String,
        roots: Vec<WorkspaceRoot>,
        configuration: SearchConfiguration,
    },
    FileSearch {
        version: u32,
        request_id: String,
        query: String,
        max_results: usize,
        active_editor: Option<ActiveEditor>,
    },
    TextSearch {
        version: u32,
        request_id: String,
        query: String,
        options: TextSearchOptions,
        overlays: Vec<DocumentOverlay>,
    },
    Cancel {
        version: u32,
        request_id: String,
        target_request_id: String,
    },
    Status {
        version: u32,
        request_id: String,
    },
    Shutdown {
        version: u32,
        request_id: String,
    },
}

impl Request {
    pub fn version(&self) -> u32 {
        match self {
            Self::Initialize { version, .. }
            | Self::Reconfigure { version, .. }
            | Self::FileSearch { version, .. }
            | Self::TextSearch { version, .. }
            | Self::Cancel { version, .. }
            | Self::Status { version, .. }
            | Self::Shutdown { version, .. } => *version,
        }
    }
    pub fn request_id(&self) -> &str {
        match self {
            Self::Initialize { request_id, .. }
            | Self::Reconfigure { request_id, .. }
            | Self::FileSearch { request_id, .. }
            | Self::TextSearch { request_id, .. }
            | Self::Cancel { request_id, .. }
            | Self::Status { request_id, .. }
            | Self::Shutdown { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    pub uri: String,
    pub relative_path: String,
    pub root_id: String,
    pub score: i64,
    pub positions: Vec<u32>,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub uri: String,
    pub root_id: String,
    pub line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub preview: String,
    pub preview_start: u32,
    pub preview_end: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Response {
    IndexProgress {
        version: u32,
        request_id: String,
        root_id: String,
        files_indexed: usize,
    },
    IndexReady {
        version: u32,
        request_id: String,
        file_count: usize,
    },
    FileResults {
        version: u32,
        request_id: String,
        results: Vec<FileMatch>,
        partial: bool,
    },
    TextResultBatch {
        version: u32,
        request_id: String,
        results: Vec<TextMatch>,
    },
    TextSearchComplete {
        version: u32,
        request_id: String,
        result_count: usize,
        limit_hit: bool,
        cancelled: bool,
        warnings: Vec<String>,
    },
    RequestError {
        version: u32,
        request_id: String,
        code: String,
        message: String,
    },
    Diagnostics {
        version: u32,
        request_id: String,
        ready: bool,
        file_count: usize,
        roots: usize,
        generation: u64,
        last_error: Option<String>,
    },
}
