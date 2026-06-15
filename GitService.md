# GitService

> Base URL: `https://git.freischule.info`

## Übersicht

Der GitService ist der zentrale Abstraktionslayer für alle Git-Operationen in der Freischule-Architektur. Er abstrahiert den darunterliegenden Git-Provider (GitHub oder Gitea) vollständig, sodass alle anderen Komponenten — Frontend, `gts` CLI und Claude Code — unabhängig vom Backend arbeiten.

**Kernverantwortlichkeiten:**
- Issues entgegennehmen (Frontend) und an den konfigurierten Git-Provider weiterleiten
- `gts` CLI-Befehle für Claude Code bereitstellen (Kommentare, Issue schließen, Issue lesen)
- Bei neuen Kommentaren von Claude Code automatisch eine Email an den Issue-Ersteller senden
- Email-Antworten des Users als Kommentar in den Issue posten
- Git-Provider-spezifische Details (API-Keys, Label-IDs vs. Label-Namen) intern kapseln

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Sprache:** JavaScript (ESM)
- **Auth:** JWT (Frontend-Endpoints) + API-Key (CLI- und Webhook-Endpoints)
- **Abhängigkeiten:** `axios` für HTTP-Clients, `dotenv` für Konfiguration

---

## Konfiguration (`.env`)

```env
PORT=3000

# Git Provider: "github" oder "gitea"
GIT_PROVIDER=gitea

# GitHub
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=freischule

# Gitea
GITEA_BASE_URL=https://gitea.freischule.info
GITEA_TOKEN=...
GITEA_OWNER=freischule

# Interne Auth
API_KEY=...
JWT_PUBLIC_KEY_PATH=./keys/public.pem

# EmailService
EMAIL_SERVICE_URL=https://email.freischule.info
EMAIL_SERVICE_API_KEY=...
EMAIL_FROM=gitservice@flussmark.de
EMAIL_REPLY_TO=gitservice@flussmark.de
```

---

## Projektstruktur

```
/
├── src/
│   ├── index.js                  # Express-App, Routen registrieren
│   ├── config.js                 # Umgebungsvariablen laden und validieren
│   ├── middleware/
│   │   ├── authJwt.js            # JWT-Validierung für Frontend-Endpoints
│   │   └── authApiKey.js         # API-Key-Validierung für CLI- und Webhook-Endpoints
│   ├── clients/
│   │   ├── gitClient.js          # Factory: gibt GitHubClient oder GiteaClient zurück
│   │   ├── githubClient.js       # GitHub REST API Implementierung
│   │   ├── giteaClient.js        # Gitea REST API Implementierung
│   │   └── emailClient.js        # EmailService HTTP-Client
│   ├── routes/
│   │   ├── public.js             # GET / und GET /health
│   │   ├── frontend.js           # Frontend-Endpoints (JWT)
│   │   ├── cli.js                # gts CLI-Endpoints (API-Key)
│   │   └── webhook.js            # Webhook-Endpoints (API-Key)
│   └── services/
│       └── issueService.js       # Business-Logik: Email versenden, Subject parsen etc.
├── .env
├── .env.example
├── package.json
└── CLAUDE.md
```

---

## Git Client Interface

Beide Clients (`githubClient.js` und `giteaClient.js`) implementieren dasselbe Interface:

```js
// Alle Methoden sind async und geben normalisierte Objekte zurück
getRepos()                                        // → [{ name, fullName, url }]
getIssue(repo, number)                            // → { number, title, body, state, creator, url }
createIssue(repo, { title, body, labels })        // → { number, url }
createComment(repo, number, body)                 // → { id }
closeIssue(repo, number)                          // → void
```

**Normalisierung:** Gitea verwendet numerische Label-IDs, GitHub String-Namen. `giteaClient.js` löst Label-Namen intern zu IDs auf, sodass die Route immer mit Namen arbeitet.

---

## API-Endpunkte

### Public

| Method | Endpoint  | Auth | Description |
|--------|-----------|------|-------------|
| `GET`  | `/`       | —    | Hello World — `"I'm the GitService."` |
| `GET`  | `/health` | —    | `{ status, service, provider, timestamp }` |

---

### Frontend API (JWT Auth)

#### `GET /repos`
Gibt alle verfügbaren Repositories zurück. Wird vom Frontend für das Repo-Dropdown beim Erstellen eines Issues genutzt.

**Response `200`:**
```json
[
  { "name": "freischule-backend", "fullName": "freischule/freischule-backend", "url": "..." },
  { "name": "freischule-frontend", "fullName": "freischule/freischule-frontend", "url": "..." }
]
```

---

#### `POST /issue`
Erstellt einen neuen Issue im angegebenen Repository.

**Request Body:**
```json
{
  "repo": "freischule-backend",
  "title": "Login schlägt fehl bei Sonderzeichen im Passwort",
  "body": "Wenn das Passwort ein @ enthält, kommt ein 500er zurück.",
  "labels": ["bug"]
}
```

| Feld     | Typ      | Pflicht | Beschreibung |
|----------|----------|---------|--------------|
| `repo`   | string   | ✅      | Repository-Name (aus `/repos`) |
| `title`  | string   | ✅      | Kurze Überschrift |
| `body`   | string   | ✅      | Ausführliche Beschreibung / Fehlerdetails |
| `labels` | string[] | —       | `bug`, `feature`, `refactor` |

**Response `201`:**
```json
{
  "number": 42,
  "url": "https://gitea.freischule.info/freischule/freischule-backend/issues/42"
}
```

---

#### `POST /issue/:number/comment`
Ermöglicht dem User, eine Antwort auf eine Rückfrage von Claude Code direkt aus dem Frontend zu posten.

**URL-Parameter:** `:number` — Issue-Nummer

**Request Body:**
```json
{
  "repo": "freischule-backend",
  "body": "Ja, der Button soll auch auf Mobile sichtbar sein."
}
```

**Response `201`:**
```json
{ "id": 7 }
```

---

### CLI API — `gts` (API-Key Auth)

Diese Endpoints werden ausschließlich vom `gts` CLI genutzt, das Claude Code auf dem Entwickler-PC ausführt. Der API-Key wird lokal in `~/.gtsrc` gespeichert. Das Repo wird aus dem Git-Remote des aktuellen Verzeichnisses ausgelesen.

#### `GET /cli/issue/:number`
Liest einen Issue. Claude Code nutzt dies um den vollen Issue-Inhalt abzurufen.

**Query-Parameter:** `repo` (Repository-Name)

**Response `200`:**
```json
{
  "number": 42,
  "title": "Login schlägt fehl bei Sonderzeichen im Passwort",
  "body": "Wenn das Passwort ein @ enthält, kommt ein 500er zurück.",
  "state": "open",
  "creator": "kurt",
  "url": "..."
}
```

---

#### `POST /cli/issue/:number/comment`
Claude Code postet einen Kommentar — entweder eine Rückfrage oder eine Statusmeldung.

Der GitService erkennt anhand des Label-Inhalts oder eines optionalen `type`-Feldes ob es eine Frage ist und sendet in diesem Fall automatisch eine Email an den Issue-Ersteller.

**Request Body:**
```json
{
  "repo": "freischule-backend",
  "body": "Frage: Soll der Fehler auch geloggt werden oder nur dem User angezeigt werden?",
  "type": "question"
}
```

| Feld   | Typ    | Pflicht | Beschreibung |
|--------|--------|---------|--------------|
| `repo` | string | ✅      | Repository-Name |
| `body` | string | ✅      | Kommentartext |
| `type` | string | —       | `question` → triggert Email an Issue-Ersteller |

**Verhalten bei `type: "question"`:**
1. Kommentar wird in den Issue gepostet
2. GitService ruft `POST /emails` am EmailService auf:
   - `to`: Email-Adresse des Issue-Erstellers
   - `subject`: `[GitService #42] Frage zu: Login schlägt fehl bei Sonderzeichen`
   - `body`: Kommentartext + Link zum Issue
   - `replyTo`: `gitservice@flussmark.de`

**Response `201`:**
```json
{ "id": 8, "emailSent": true }
```

---

#### `PATCH /cli/issue/:number/close`
Schließt einen Issue. Claude Code ruft dies nach erfolgreichem Abschluss auf.

**Request Body:**
```json
{ "repo": "freischule-backend" }
```

**Response `200`:**
```json
{ "number": 42, "state": "closed" }
```

---

### Webhook API (API-Key Auth)

#### `POST /webhook/email-reply`
Wird vom EmailService aufgerufen, wenn eine Antwort-Email auf `gitservice@flussmark.de` eingegangen ist. Der EmailService liefert Absender, Betreff und Body — der GitService parst die Issue-Nummer aus dem Betreff und postet den Body als Kommentar.

**Request Body:**
```json
{
  "from": "kurt@flussmark.de",
  "subject": "Re: [GitService #42] Frage zu: Login schlägt fehl bei Sonderzeichen",
  "body": "Ja, bitte beides — loggen und dem User anzeigen."
}
```

**Verarbeitung:**
1. Issue-Nummer aus Subject parsen via Regex `/\[GitService #(\d+)\]/`
2. Repo aus dem aktiven offenen Issue ermitteln (GitService merkt sich offene Issues intern oder fragt alle konfigurierten Repos ab)
3. `body` als Kommentar in den Issue posten
4. Optional: Label `needs-clarification` entfernen falls gesetzt

**Response `200`:**
```json
{ "number": 42, "commentId": 9 }
```

**Response `422`** wenn keine Issue-Nummer im Subject gefunden:
```json
{ "error": "Could not parse issue number from subject" }
```

---

## `gts` CLI

Das `gts` CLI ist ein schlankes Node.js-Script das global installiert wird (`npm install -g`) und die CLI-API des GitService aufruft.

### Konfiguration (`~/.gtsrc`)
```json
{
  "baseUrl": "https://git.freischule.info",
  "apiKey": "...",
}
```

### Repo-Erkennung
Das Repo wird automatisch aus dem Git-Remote des aktuellen Verzeichnisses gelesen:
```bash
git remote get-url origin
# → https://gitea.freischule.info/freischule/freischule-backend.git
# → repo = "freischule-backend"
```

### Befehle

```bash
# Issue lesen
gts issue view 42

# Kommentar posten (Statusmeldung)
gts issue comment 42 --body "Implementierung abgeschlossen."

# Kommentar posten mit Email-Trigger
gts issue comment 42 --body "Frage: Soll der Fehler auch geloggt werden?" --type question

# Issue schließen
gts issue close 42
```

### Eintrag in `CLAUDE.md` (in jedem Service-Repo)

```markdown
## Issue-Workflow

Statt `gh` wird `gts` genutzt (GitService CLI):

- Issue lesen:     `gts issue view <number>`
- Kommentar:       `gts issue comment <number> --body "..."`
- Rückfrage:       `gts issue comment <number> --body "Frage: ..." --type question`
- Issue schließen: `gts issue close <number>`

Nach Abschluss eines Issues immer `gts issue close <number>` aufrufen.
Falls Unklarheiten bestehen, zuerst `--type question` kommentieren und den Issue NICHT schließen.
```

---

## Email-Flow Übersicht

```
Claude Code
  → gts issue comment 42 --body "Frage: ..." --type question
  → POST /cli/issue/42/comment  (GitService)
  → Kommentar in Gitea/GitHub
  → POST /emails  (EmailService)
  → Email an Issue-Ersteller
      Subject: "[GitService #42] Frage zu: ..."
      ReplyTo: gitservice@flussmark.de

User antwortet auf Email
  → landet in gitservice@flussmark.de
  → EmailService pollt IMAP, erkennt Antwort
  → POST /webhook/email-reply  (GitService)
  → GitService parst #42 aus Subject
  → Kommentar in Gitea/GitHub
```

---

## Auth-Varianten

| Endpoint-Gruppe | Auth-Methode | Header |
|----------------|--------------|--------|
| Public (`/`, `/health`) | — | — |
| Frontend (`/repos`, `/issue`, `/issue/:number/comment`) | JWT mit beliebiger Rolle | `Authorization: Bearer <token>` |
| CLI (`/cli/*`) | API-Key | `X-API-Key: <key>` |
| Webhook (`/webhook/*`) | API-Key | `X-API-Key: <key>` |

---

## Fehlerbehandlung

- Gitea/GitHub nicht erreichbar beim `POST /issue`: `503` zurückgeben, kein interner Retry (Frontend zeigt Fehlermeldung)
- EmailService nicht erreichbar nach `gts issue comment --type question`: Kommentar trotzdem posten, Email-Fehler loggen aber nicht als Fehler an den Caller zurückgeben (`emailSent: false` in Response)
- Webhook mit unparsebarem Subject: `422` zurückgeben, EmailService loggt den Fehler

---

## GitClient (PC-Instanz)

Der GitClient ist ein separates Node.js-Programm das auf dem Entwickler-PC läuft. Er ist kein Server — er ist ein autonomer Consumer der den GitService periodisch abfragt, offene Issues lädt und Claude Code dafür startet.

**Kernverantwortlichkeiten:**
- Authentifizierung gegen AuthService mit dediziertem GITCLIENT-Account
- Periodisches Polling aller registrierten Repos auf offene Issues
- Claude Code pro Issue im richtigen Repo-Verzeichnis starten
- `gts` CLI bereitstellen (ruft GitService CLI-API auf)

### Projektstruktur

```
/
├── src/
│   ├── index.js          # Einstiegspunkt: Polling-Loop starten
│   ├── auth.js           # Login, Token-Speicherung, automatischer Refresh
│   ├── poller.js         # Issues vom GitService laden, neue Issues erkennen
│   ├── runner.js         # Claude Code per child_process.spawn starten
│   └── gts.js            # CLI-Einstiegspunkt für gts-Befehle
├── .env
├── .env.example
└── package.json
```

### Konfiguration (`.env`)

```env
# GitService
GIT_SERVICE_URL=https://git.freischule.info

# AuthService
AUTH_SERVICE_URL=https://auth.freischule.info

# Lokale Repo-Verzeichnisse (Repo-Name → absoluter Pfad)
REPO_PATHS=freischule-backend:/home/kurt/git/freischule-backend,freischule-frontend:/home/kurt/git/freischule-frontend

# Polling-Intervall in Sekunden
POLL_INTERVAL=60
```

### Token-Speicherung (`~/.gitclient/tokens.json`)

```json
{
  "access_token": "eyJ...",
  "refresh_token_cookie": "...",
  "csrf_token": "..."
}
```

Tokens werden lokal gespeichert. Der Access-Token wird vor jedem API-Aufruf auf Ablauf geprüft — läuft er ab, wird automatisch `POST /user/refresh` am AuthService aufgerufen. Nach 14 Tagen ohne Nutzung (Refresh-Token abgelaufen) fragt der GitClient beim nächsten Start erneut nach Email + Passwort.

### Erstmaliger Start (Setup)

```
$ gitclient start

GitClient - Ersteinrichtung
Email (GITCLIENT-Account): gitclient-pc@freischule.info
Passwort: ****

✅ Login erfolgreich. Tokens gespeichert unter ~/.gitclient/tokens.json
🔄 Starte Polling alle 60 Sekunden...
```

### Polling-Loop

```
Alle 60 Sekunden:
  GET /issues?state=open  (GitService, alle registrierten Repos)
  → Vergleich mit lokaler Liste bereits gestarteter Issues (in-memory)
  → Neue Issues → runner.js startet Claude Code
  → Bereits bekannte Issues → überspringen
```

### Claude Code starten (`runner.js`)

```js
const { spawn } = require('child_process');

spawn('claude', ['-p', `Bearbeite diesen Issue: ${issue.url}`], {
  cwd: repoPaths[issue.repo],  // aus REPO_PATHS Konfiguration
  stdio: 'inherit'
});
```

Claude Code liest die lokale `CLAUDE.md` des Repos und arbeitet den Issue selbstständig ab. Der Issue-URL enthält alle nötigen Informationen — Claude Code liest den Issue via `gts issue view` und postet Ergebnisse via `gts issue comment`.

### `gts` CLI (`gts.js`)

Das `gts`-Binary wird zusammen mit dem GitClient installiert (`npm install -g`). Es liest die gespeicherten Tokens aus `~/.gitclient/tokens.json` und spricht gegen die CLI-API des GitService.

```bash
# Verfügbare Befehle
gts issue view <number> --repo <repo>
gts issue comment <number> --repo <repo> --body "..." [--type question]
gts issue close <number> --repo <repo>
```

Das `--repo`-Flag wird automatisch aus dem Git-Remote des aktuellen Verzeichnisses befüllt — muss nur explizit angegeben werden wenn der GitClient außerhalb eines Repo-Verzeichnisses läuft.

### Auth-Anforderungen an den AuthService

Der GitClient nutzt einen **dedizierten GITCLIENT-User-Account** — niemals den Admin-Account. Der AuthService enforced diese Trennung (siehe AuthService Issue #GITCLIENT-ROLE-ENFORCEMENT):

- Rolle `GITCLIENT` darf nur einem User zugewiesen werden der **keine anderen Rollen** hat
- Ein User mit `GITCLIENT`-Rolle darf keine weiteren Rollen erhalten
- GitService akzeptiert auf CLI-Endpoints (`/cli/*`) nur JWTs mit der Rolle `GITCLIENT`

**Einmalige Einrichtung (durch Admin):**
```
1. Neuen User anlegen: gitclient-pc@freischule.info
2. POST /admin/set_roles { "user_id": "...", "roles": ["GITCLIENT"] }
3. Passwort sicher an den GitClient-Betreiber übergeben
4. GitClient starten → Email + Passwort eingeben → fertig
```
