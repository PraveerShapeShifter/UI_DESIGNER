---
description: Build & preview ThreadValidate CAD, open it in a Claude MCP-controlled Chrome tab, and run the full walkthrough — local fail → report → re-upload → pass, plus the Google Drive connect → pick → validate path.
---

You are running the **ThreadValidate CAD** demo end-to-end. Working directory is the
project root (`C:\ShapeShifter_code\UI_designer`). Do every step in order and do NOT
pause to ask for confirmation between steps.

## 1. (Re)build and start a clean preview server
- Stop any existing project Vite servers, then start a fresh preview in the background:
  - Stop: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'UI_designer.*vite' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
  - (Optional) If source changed since the last build, run `npm run build` first.
  - Start: run `npm run preview` with run_in_background.
- Read the background task's output file to confirm the URL (expected **http://localhost:4173/**;
  if 4173 was busy it may pick another port — use whatever it prints).

## 2. Open it in a Claude MCP-controlled Chrome tab
- If the `mcp__claude-in-chrome__*` tools are not loaded, load them with ONE ToolSearch call
  (tabs_context_mcp, navigate, computer, browser_batch, javascript_tool).
- Call `tabs_context_mcp` with `createIfEmpty: true`, then `navigate` that tab to the preview URL.
- Take a screenshot to confirm the page loaded.

## 3. Run the full walkthrough (ALWAYS show BOTH Fail and Pass)
The per-file Gerber verdict is driven by the on-page **Fail / Pass** demo toggle, and packages
are loaded via the **Load sample** buttons (I cannot operate the native OS file picker).
After each click that changes layout, take a screenshot to locate the next button before clicking
(coordinates shift with viewport size).

a. **Fail:** ensure the toggle is on **Fail**, click **Valid package**, then **Validate Files**.
   Screenshot the red **Validation Failed** state showing the failed `.tmp` list + contents chips.
b. **Report:** click **Download report (PDF)**. Confirm a PDF appeared in `~/Downloads`
   named after the uploaded zip (e.g. `ls -t ~/Downloads/*.pdf`). Optionally open it to verify.
c. **Re-upload → Pass:** click the **Pass** toggle, click **Valid package** again
   (this represents re-uploading the corrected zip), then **Validate Files**.
   Screenshot the green **Validation Passed** state.

## 3.5 Google Drive path (simulated Drive — no credentials)
The Drive section sits just below the drop zone. Demo the connect → pick → validate flow:

d. **Connect:** if it shows **"Connect Google Drive"**, click it and wait (~1s) for the connected
   chip "Google Drive · <email>". (If it already shows connected from a remembered session, skip.)
e. **Pick from Drive:** click **Pick file from Drive** → a modal "Your Google Drive" lists sample
   `.zip` packages. Screenshot it, then click one entry. Confirm the chosen package lands in the
   **Selected** state (name + size).
f. **Validate the Drive-sourced file:** with the toggle on **Pass**, click **Validate Files** and
   screenshot the green **Validation Passed** — proving a Drive-picked file flows through the same
   validation as local uploads.
   (Note: this is the simulated Drive — no real Google account; the modal says so.)

## 4. Summarize
Report what was shown at each step (package name, fail details, report filename, pass result, and
the Drive connect/pick/validate outcome) and leave the server running with the MCP tab on the final
Pass state.

### Notes
- `npm run preview` only *serves* the page; the browser automation (open tab + clicks) is driven
  by you via MCP — that is why the app appears under Claude's control.
- Honor the saved preferences: always open in an MCP-controlled tab, and always demo both states.
