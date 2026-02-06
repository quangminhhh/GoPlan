# AGENT.md

## Language Policy
- Interact with the human owner **in Vietnamese** (explanations, confirmations).

## Purpose

Defines how the AI coding agent ("Codex") must operate in this repository.

## Scope — Backend Only (Django + Django REST Framework)

`CONTEXT-n.md` applies **only** to the backend implemented with **Django** and **Django REST Framework (DRF)**. Ignore frontend, infra/DevOps, or non-backend concerns unless explicitly requested by the human.

## Repository Layout & File Locations

* **Repo root**: `/` — place `AGENT.md` here (this file).
* **Backend root**: `/backend/` — Django + DRF codebase (focus of this document).
* **Frontend root**: `/frontend/` — ignore unless the human requests otherwise.
* **Context directory**: `/backend/context/` — **only** here do context files live.
* **Context files**: `/backend/context/CONTEXT-<n>.md` where `<n>` ∈ ℕ (1,2,3,...). `CONTEXT-1.md` is the oldest baseline.
* **Read order**: scan `/backend/context/` for `CONTEXT-*.md`, sort by `<n>` ascending, read **1→n**.
* **Write location**: when instructed, create `/backend/context/CONTEXT-(n+1).md`.
* **Do not** read or write any `CONTEXT-*.md` outside `/backend/context/`.

## Language Policy

* Interact with the human owner **in Vietnamese** (VI).
* Any artifact added to the repository (**code, diffs, PRs, docs, commit messages, comments, TODOs**) must be **in English** (EN).
* Interact with the human owner **in Vietnamese** (VI).
* Any artifact added to the repository (**code, diffs, PRs, docs, commit messages, comments, TODOs**) must be **in English** (EN).

---

## CONTEXT Files Are Machine-Oriented (Backend Django/DRF)

**Meaning.** `CONTEXT-n.md` are machine-focused narratives encoding the backend **current logic** in a **structured, parseable** way, aligned to Django apps/models/migrations/settings and DRF serializers/viewsets/routers/permissions.

**What Codex must gain after reading ALL 1→n:**

* Consolidated **invariants, rules, edge cases**, and **deprecated→replacement** behaviors.
* Accurate view of **Django apps**, **models/schema & migrations**, **settings (including `REST_FRAMEWORK`)**, **serializers**, **viewsets/routers**, **permissions/auth**, **URL routing**, **signals**, and **test oracles**.
* A ready-to-use **Working Facts** bundle (see Reading Procedure) that guides implementation immediately.

**Access & Authority (strict):**

* Do **NOT** read any `CONTEXT-*.md` unless explicitly instructed by the human.
* When instructed, read **all** `CONTEXT-1.md … CONTEXT-n.md` in ascending order. Higher `n` **overrides** lower `n`.
* After reading, acknowledge in **Vietnamese** and publish **Working Facts** (EN) before coding.

**Writing (strict):**

* Do **NOT** create a new file unless explicitly instructed by the human.
* When told to write the next version, produce **one** file `CONTEXT-(n+1).md` following the schema below, capturing *logic-level* backend changes since `CONTEXT-n.md` (avoid trivial refactors).

**Human trigger phrases (Vietnamese):**

* “**Đọc CONTEXT Backend giúp tôi**” → Read all 1→n; publish Working Facts (EN) + VI acknowledgment.
* “**Viết CONTEXT Backend mới**” → Create `CONTEXT-(n+1).md` per schema.
* “**Tóm tắt CONTEXT Backend**” → Provide an English summary + one-liner VI.

---

## Authoring Guidelines for `CONTEXT-n.md` (Machine-Readable)

**Goal.** Produce a machine-readable snapshot of backend logic that an AI can parse deterministically and use to make correct changes.

**Hard rules:**

1. File is Markdown with **YAML frontmatter** + **JSON blocks** only. JSON must be **valid** (no comments, no trailing commas).
2. IDs must be **stable** and lowercase using `[-a-z0-9_]`.
3. Only include **logic-level** changes (business rules, contracts, schema, permissions). Omit noise (formatting-only, stylistic refactors).
4. Prefer **linking by ID** across blocks (e.g., serializer → model; viewset → serializer/permission; router → viewset).
5. For deprecations, always provide **replacement** and **migration status**.
6. Keep examples minimal and normative; avoid prose unless clarifying an edge case.

**Authoring procedure when the human requests a new context:**

1. **Collect facts** from the latest PR/changes you just implemented.
2. **Diff against previous context (`CONTEXT-n.md`)** and identify logic deltas.
3. **Edit/append** relevant JSON blocks in the new `CONTEXT-(n+1).md` to reflect deltas.
4. **Resolve overrides:** Add superseded IDs to `frontmatter.supersedes`.
5. **Validate** (see Validation Checklist).
6. **Save** the file to **`/backend/context/CONTEXT-(n+1).md`**.

**Validation checklist (must pass):**

* YAML frontmatter has: `version`, `date`, `base`, `supersedes`, `codebase_sha`, `scope`, `blocks`.
* File path is exactly **`/backend/context/CONTEXT-<n>.md`** and `<n>` is the next integer.
* Every JSON block is valid JSON; keys match schemas below or a declared **custom block schema**.
* All cross-references by `id`/`name` resolve.
* No orphaned or duplicate IDs after applying `supersedes`.
* At least one **test oracle** exists for each new/changed API or invariant.

## Block Registry & Flexible Schema

**Design goal.** Allow each project to include only what exists, and extend with project-specific concepts (e.g., special services) without changing this AGENT spec.

**Frontmatter contract (extended):**

```yaml
version: n
date: YYYY-MM-DD
base: CONTEXT-(n-1)
supersedes: []
codebase_sha: "<git sha or tag>"
scope: "backend logic update summary (Django/DRF only)"
blocks:  # list the JSON blocks present in this file, by name
  - django_project
  - apps
  - models
  - migrations
  - serializers
  - viewsets
  - routers
  - urls
  - invariants
  - tests_oracles
strategy: split  # or: unified
```

**Two authoring strategies (choose one per file):**

* `split` (**recommended**): keep granular blocks (e.g., `serializers.json`, `viewsets.json`, `routers.json`, `urls.json`).
* `unified`: use a single `apis.json` that embeds endpoints, serializers, permissions, and routing. If both appear, `apis.json` is **authoritative**.

**Core blocks (SHOULD when applicable):**

* `django_project.json` — settings snapshot (backend-relevant).
* `apps.json` — Django apps and purposes.
* `models.json` — models/fields/constraints/indexes.
* `migrations.json` — schema/data migration state.
* Either `serializers.json` + `viewsets.json` + `routers.json` + `urls.json` **or** a unified `apis.json`.
* `invariants.json` — key business rules.
* `tests_oracles.json` — API/test scenarios to assert behavior.

**Optional blocks (add only if used):**

* `permissions.json`, `signals.json`, `management_commands.json`, `tasks.json` (e.g., Celery), `channels.json` (websocket), `throttling.json`, `rate_limits.json`, `caching.json`, `feature_flags.json`, `search.json` (e.g., ES), `external_integrations.json` (Stripe/S3/etc.), `notifications.json`, `schedules.json` (periodic jobs), `compatibility.json`, `edge_cases.json`, `open_questions.json`.

**Custom blocks (project-specific):**

* Name as `ext-<name>.json` (e.g., `ext-billing.json`, `ext-ml-serving.json`).
* Must follow this **generic meta-schema**:

```json
{
  "type": "<domain|service|policy|capability>",
  "id": "ext_billing",
  "summary": "Billing service contracts & flows",
  "spec": {"…": "domain-specific keys"},
  "links": ["model:invoice", "api:api_invoice_create"],
  "lifecycle": {"status": "active", "deprecated": null, "replacement": null}
}
```

* Reference other blocks via `links` using stable IDs (e.g., `model:<App.Model>`, `api:<id>`, `permission:<id>`).

> The schema below shows **examples**. Include only blocks relevant to your project; add custom `ext-*.json` blocks for anything not covered.

## Machine-Readable Schema for `CONTEXT-n.md` (Examples) (Django/DRF)

Each section is a **separate JSON block**. Include only sections you need; when present, follow the exact key shapes.

**Frontmatter (YAML):**

```yaml
version: n
date: YYYY-MM-DD
base: CONTEXT-(n-1)
supersedes: [ids overridden by this version]
codebase_sha: "<git sha or tag>"
scope: "backend logic update summary (Django/DRF only)"
```

**1) django_project.json** — global settings snapshot (backend-relevant)

```json
{
  "settings": {
    "DEBUG": false,
    "ALLOWED_HOSTS": ["example.com"],
    "DATABASES": {"default": {"ENGINE": "django.db.backends.postgresql", "NAME": "app"}},
    "INSTALLED_APPS": ["django.contrib.auth", "rest_framework", "app.users"],
    "MIDDLEWARE": ["django.middleware.security.SecurityMiddleware", "corsheaders.middleware.CorsMiddleware"],
    "AUTH_USER_MODEL": "users.User",
    "REST_FRAMEWORK": {
      "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework_simplejwt.authentication.JWTAuthentication"],
      "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
      "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema"
    },
    "CORS": {"enabled": true, "allowed_origins": ["https://frontend.example.com"]}
  }
}
```

**2) apps.json** — Django apps and purposes

```json
[{"label":"users","purpose":"user accounts & auth domain"}]
```

**3) models.json** — models, fields, constraints, indexes

```json
[{"app":"users","model":"User","fields":[{"name":"id","type":"uuid"},{"name":"email","type":"string","unique":true}],"constraints":[{"type":"unique_together","fields":["email"]}]}]
```

**4) migrations.json** — schema & data migration state

```json
[{"app":"users","last_applied":"0005_user_add_timezone","pending":[],"data_migrations":[{"id":"dm_2025_fix_emails","status":"applied"}]}]
```

**5) serializers.json**

```json
[{"id":"sz_user_public","model":"users.User","expose":["id","email"]}]
```

**6) permissions.json**

```json
[{"id":"perm_is_staff_or_self","rule":"allow if request.user.is_staff or request.user.id==obj.id"}]
```

**7) viewsets.json** — DRF viewsets, actions, bindings

```json
[{"id":"vs_user","model":"users.User","serializer":"sz_user_public","permissions":["perm_is_staff_or_self"],"actions":["list","retrieve","update"]}]
```

**8) routers.json** — routers & prefixes

```json
[{"id":"router_v1","prefix":"users","viewset":"vs_user","version":"v1"}]
```

**9) urls.json** — URL patterns & versioning

```json
[{"pattern":"/api/v1/users/","target":"router_v1"}]
```

**(Alternative) apis.json** — unified API contracts (authoritative if present)

```json
[{
  "id": "api_users",
  "version": "v1",
  "path": "/api/v1/users/",
  "bindings": {"viewset": "vs_user"},
  "methods": ["GET","POST"],
  "serializer_in": null,
  "serializer_out": "sz_user_public",
  "permissions": ["perm_is_staff_or_self"],
  "errors": [{"code":"email_exists"}],
  "throttling": {"scope":"user"}
}]
```

**10) signals.json** — signal receivers & effects

```json
[{"id":"sig_create_profile","signal":"post_save(users.User)","effect":"create related profile on first save"}]
```

**11) tasks.json** — background tasks (e.g., Celery)

```json
[{"id":"task_send_welcome","name":"app.users.tasks.send_welcome","queue":"default","trigger":"post_commit","retries":3}]
```

**12) management_commands.json** — management commands

```json
[{"name":"rebuild_search_index","module":"app.search.management.commands"}]
```

**13) tests_oracles.json** — API test scenarios (backend truth)

```json
[{"id":"t_user_unique_email","api":"POST /api/v1/users/","payload":{"email":"a@x.com"},"expected":{"status":400,"code":"email_exists"}}]
```

**14) invariants.json** — business rules & SLOs (backend)

```json
[{"id":"inv_unique_email","statement":"Email is globally unique among active users"}]
```

**15) edge_cases.json**

```json
[{"id":"edge_email_unicode","rule":"normalize to NFC before uniqueness check"}]
```

**16) compatibility.json** — deprecations and migrations

```json
[{"deprecated":"api:/v0/users/","replacement":"api:/v1/users/","migration":"301 redirect until 2026-01-01"}]
```

**17) open_questions.json**

```json
[{"id":"q_rate_limit_reset","question":"What is the per-IP password-reset rate limit?"}]
```

**18) ext-billing.json** — example custom block

```json
{
  "type": "service",
  "id": "ext_billing",
  "summary": "Billing microservice contracts",
  "spec": {
    "base_url": "https://billing.internal",
    "contracts": [
      {"id":"svc_invoice_create","method":"POST","path":"/invoices","request":{"user_id":"uuid","amount":"decimal"},"response":{"invoice_id":"uuid"}}
    ],
    "timeouts_ms": {"connect": 500, "read": 2000}
  },
  "links": ["model:billing.Invoice", "api:api_users"],
  "lifecycle": {"status": "active", "deprecated": null, "replacement": null}
}
```

> Add blocks only as needed; when present, keep the key shapes as above; prefer adding `ext-*.json` for project-specific concepts.

---

## Reading Procedure (Codex)

0. **Locate files**: list `CONTEXT-*.md` under **`/backend/context/`** only. Ignore any similarly named files elsewhere.
1. Parse YAML frontmatter; confirm highest `version` corresponds to the largest `<n>` in filenames. Read `blocks` and `strategy` to discover which JSON blocks are present.
2. Parse all declared JSON blocks. If both `apis.json` and split blocks exist, treat `apis.json` as **authoritative** for endpoint contracts and routing.
3. Parse any `ext-*.json` custom blocks and merge them into the internal graph keyed by `id`.
4. Apply `supersedes` + high-`n` overrides to resolve conflicts.
5. Emit **Working Facts (EN)** with sections present only if data exists:

   * **Invariants**
   * **Active APIs** (from `apis.json` or from `serializers`+`viewsets`+`routers`+`urls`)
   * **Active Data Entities** (models/fields)
   * **Permissions/Auth** (DRF + custom)
   * **Migrations state**
   * **Edge Cases**
   * **Test Oracles**
   * **Extensions** (summaries of each `ext-*.json`)
6. Confirm in **Vietnamese** what was understood and any assumptions.

## Default Workflow

1. Confirm task (VI) → 2) (Optional) Read context on demand → 3) Plan (EN) → 4) Implement (EN) → 5) Tests (EN) → 6) Runbook (EN) → 7) Follow-ups (EN).

## Conventions

* Minimal diffs; preserve style; no unrelated reformatting.
* Use placeholders for secrets; maintain `.env.example`.
* Commit messages, PRs, and docs are **English-only**.
