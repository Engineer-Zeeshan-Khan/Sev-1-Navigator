# Sev-1 Navigator

Local-first Electron desktop application for SEV-1 incident response.

## Requirements
- Node.js 20 or later
- npm
- macOS or Windows

## Run
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
npm run package
```

## Excel configuration
From the Excel Configuration page, create the workbook. It contains:
- Activities
- Tools
- Communication Templates

The app copies the bundled workbook into Electron's userData folder on first launch. The Excel Configuration screen shows the active workbook path and offers an Import workbook action. A successful import becomes the startup configuration. Existing incidents retain their original task snapshots; new incidents use the updated configuration.

## Local data
SQLite is stored in Electron's userData directory. The app does not require a cloud service. Back up the database before major configuration changes.

## Important notes
- Replace sample `example.com` tool URLs with your authorised internal URLs.
- Do not enter customer secrets or credentials in the workbook.
- Validate all templates against your organisation's approved incident communication process.
- Test notification behaviour and packaged builds on each target operating system.

### Workbook behaviour
Rows removed from the workbook are retained in the local database for history but deactivated for future use. Re-adding the same ID reactivates/updates that entry. Keep IDs stable when editing an existing row.
