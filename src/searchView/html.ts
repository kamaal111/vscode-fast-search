type SearchViewHtmlOptions = {
  scriptUri: string;
  styleUri: string;
  cspSource: string;
  nonce: string;
};

export function searchViewHtml({
  scriptUri,
  styleUri,
  cspSource,
  nonce,
}: SearchViewHtmlOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <title>Fast Search</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; img-src ${cspSource}; font-src ${cspSource}; script-src 'nonce-${nonce}'">
  <link rel="stylesheet" href="${styleUri}">
  <style nonce="${nonce}" id="file-icon-theme"></style>
</head>
<body>
  <form id="search-form">
    <label class="sr-only" for="query">Search</label>
    <div class="search-row">
      <div class="search-input">
        <input id="query" placeholder="Search" list="history" autocomplete="off" data-help="query-help" aria-describedby="query-help">
        <div class="toggles" role="group" aria-label="Search options">
          <button type="button" data-toggle="caseSensitive" aria-label="Match Case" aria-pressed="false" data-help="case-help" aria-describedby="case-help"><span aria-hidden="true">Aa</span></button>
          <button type="button" data-toggle="wholeWord" aria-label="Match Whole Word" aria-pressed="false" data-help="word-help" aria-describedby="word-help"><span class="whole-word" aria-hidden="true">ab</span></button>
          <button type="button" data-toggle="regex" aria-label="Use Regular Expression" aria-pressed="false" data-help="regex-help" aria-describedby="regex-help"><span aria-hidden="true">.*</span></button>
        </div>
      </div>
      <button type="button" id="cancel" aria-label="Cancel Search" data-help="cancel-help" aria-describedby="cancel-help">Cancel</button>
    </div>
    <datalist id="history"></datalist>
    <label for="include" data-help="include-help">files to include</label>
    <input id="include" placeholder="e.g. src, docs, **/*.ts" data-help="include-help" aria-describedby="include-help">
    <label for="exclude" data-help="exclude-help">files to exclude</label>
    <input id="exclude" placeholder="e.g. **/node_modules/**" data-help="exclude-help" aria-describedby="exclude-help">
  </form>
  <span class="sr-only" id="query-help">Search file contents. Press Enter to run the search; typing also searches when Search on Type is enabled.</span>
  <span class="sr-only" id="case-help">Require matching uppercase and lowercase letters. When off, queries containing uppercase letters still match case through smart case.</span>
  <span class="sr-only" id="word-help">Match complete words rather than parts of words.</span>
  <span class="sr-only" id="regex-help">Interpret the search text as a regular expression.</span>
  <span class="sr-only" id="cancel-help">Stop the current search.</span>
  <span class="sr-only" id="include-help">Search only files matching these comma-separated folders or glob patterns. A folder such as src includes its contents at any depth. Use ./src for a top-level folder in a single-root workspace, or ./backend/src for a folder in the named backend root in a multi-root workspace. Leave empty to search all included files.</span>
  <span class="sr-only" id="exclude-help">Skip files matching these comma-separated glob patterns.</span>
  <div id="status" role="status" aria-live="polite"><span id="status-summary"></span> <span id="search-duration" hidden></span></div>
  <div id="results-scroll">
    <div id="results" role="tree" aria-label="Search results"></div>
    <div id="result-pagination"></div>
  </div>
  <div id="control-tooltip" role="tooltip" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
