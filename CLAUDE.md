# GitService

## Issue-Workflow

Statt `gh` wird `gts` genutzt (GitService CLI):

- Issue lesen:     `gts issue view <number>`
- Kommentar:       `gts issue comment <number> --body "..."`
- Rückfrage:       `gts issue comment <number> --body "Frage: ..." --type question`
- Issue schließen: `gts issue close <number>`

Nach Abschluss eines Issues immer `gts issue close <number>` aufrufen.
Falls Unklarheiten bestehen, zuerst `--type question` kommentieren und den Issue NICHT schließen.

## Architecture

See `GitService.md` for the full API documentation and architecture overview.

## Tech Stack

- Node.js + Express.js (ESM)
- JWT auth for frontend endpoints (RS256, public key from AuthService)
- API-Key auth for webhook endpoints
- CLI endpoints accept API-Key OR JWT with GITCLIENT role
- GitHub and Gitea clients share the same interface
