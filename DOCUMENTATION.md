# Orange Kuma Management Tool — Documentation

**Project:** Cloud S2 2526 — Orange Kuma
**Author:** Cas Emmens

A read-only customer health dashboard for the Orange Kuma platform. This
document describes its role, internals, integrations, and deployment. For
the full platform (Proxmox, k3s, GitOps provisioning) see the
[`project-cloud`](../project-cloud) repository; for the customer instance
image see [`orange-uptime-kuma`](../orange-uptime-kuma).

---

## Table of Contents

1. [Purpose & History](#1-purpose--history)
2. [What the Dashboard Shows](#2-what-the-dashboard-shows)
3. [Architecture](#3-architecture)
4. [Integrations](#4-integrations)
5. [HTTP API](#5-http-api)
6. [Security — Read-only by Design](#6-security--read-only-by-design)
7. [Configuration](#7-configuration)
8. [Container Image & CI/CD](#8-container-image--cicd)
9. [Deployment](#9-deployment)
10. [File Structure](#10-file-structure)

---

## 1. Purpose & History

The Management Tool started life as a *provisioning* UI: it created
customer namespaces and deployments directly via `kubectl`. That role has
been **pivoted away**. Provisioning is now owned by Semaphore
(Ansible → Gitea → Argo CD GitOps), which is the rubric-named tool for
non-technical staff and gives proper RBAC, audit history, and a Git
source of truth.

The tool was too useful to discard, so it was refactored into a
**strictly read-only customer health dashboard** — same branding, new
purpose. It aggregates the three sources of truth (Kubernetes, Argo CD,
Gitea) into one Orange Kuma branded view and mutates nothing.

As part of the refactor the old `POST /api/deploy` and
`DELETE /api/customers/:id` handlers, the `buildDeployment` helper, and
the `better-sqlite3` local `customers` table were all removed — Git and
the cluster are the source of truth now, so nothing is tracked locally.

---

## 2. What the Dashboard Shows

A single page lists every `customer-<slug>` namespace (one row each),
sorted by slug. For each customer:

| Column | Source | Detail |
|--------|--------|--------|
| **Klant** (slug) | k8s `customer` label | Identity. |
| **Lane** | k8s `provisioned-by` label | `sales` or `ops`. |
| **E-mail** | k8s annotation `orange-kuma/customer-email` | Contact. |
| **Pods** | k8s pods + deployment | Phase (Running/Pending/Failed), ready/desired replicas, restart count. |
| **Argo CD** | Argo CD API | Sync status + health of the lane's umbrella Application. |
| **Laatste commit** | Gitea API | Author, message, sha, timestamp of the manifest's latest commit. |
| **Aangemaakt** | k8s `creationTimestamp` | Namespace age. |

A **"Nieuwe klant aanmaken"** button deep-links to the Semaphore sales
template (the sales rep clicks here and lands in the form). The page
polls `/api/customers` every 15 seconds.

---

## 3. Architecture

```
Browser ──► Express (server.js, :4000)
               ├─► Kubernetes API   (in-cluster ServiceAccount, read-only)
               ├─► Argo CD REST API (bearer token, read-only)
               └─► Gitea API        (public repos, no token)
```

- **Backend:** Node.js ≥20, Express 4, `@kubernetes/client-node` 0.21.
  Uses Node 20's global `fetch` for the Argo CD and Gitea HTTP calls (no
  extra HTTP dependency).
- **Frontend:** static `public/{index.html,app.js,style.css}` served by
  Express — a plain table, no build step.
- **Lane mapping:** a `provisioned-by` label of `sales`/`ops` maps to a
  Gitea repo + Argo CD Application:

  | Lane | Gitea repo | Argo CD Application |
  |------|------------|---------------------|
  | `sales` | `customer-instances` | `customer-instances` |
  | `ops` | `test-customers` | `test-customers` |

  There are only two umbrella Applications (one per lane), so each is
  fetched once per refresh and reused for every customer in that lane.

Every external call is wrapped in try/catch and returns empty/null on
failure, so one unreachable backend never breaks the whole dashboard.

---

## 4. Integrations

### Kubernetes API
Via the in-cluster `management-tool` ServiceAccount.
`getClusterState(namespace)` reads the `kuma` Deployment (replica counts)
and lists pods labelled `app=orange-kuma` (phase + summed restart count).
`GET /api/customers` lists namespaces with the selector
`app=orange-kuma,customer` — the `customer` label requirement excludes
the tool's own `orange-kuma` namespace.

### Argo CD API
`getArgoAppStatus(name)` calls
`GET {ARGOCD_API_URL}/api/v1/applications/<name>` with a bearer token and
extracts `status.sync.status`, `status.health.status`, and
`operationState.finishedAt`. If no token is configured it returns nulls
(degrades gracefully). The default `ARGOCD_API_URL` is the in-cluster
plaintext service `http://argocd-server.argocd.svc` (the platform runs
Argo CD insecure), so no TLS handling is needed.

### Gitea API
`getLatestCommit(repo, slug)` calls
`GET {GITEA_URL}/api/v1/repos/{org}/{repo}/commits?path=customers/<slug>.yaml&limit=1`
and returns the first commit's author, first-line message, 7-char sha,
and date. The provisioning repos are public, so no token is required.

---

## 5. HTTP API

| Endpoint | Returns |
|----------|---------|
| `GET /api/version` | `{ version }` — the build version shown in the UI. |
| `GET /api/config` | `{ semaphoreNewCustomerUrl }` — deep-link for the new-customer button. |
| `GET /api/customers` | Array of customer objects (slug, namespace, provisionedBy, email, createdAt, repo, cluster, argocd, commit). |
| `GET *` | Serves `public/index.html` (single-page app fallback). |

There are **no** write endpoints.

---

## 6. Security — Read-only by Design

The dashboard mutates nothing. Its ServiceAccount ClusterRole (defined in
`project-cloud` at `k8s/management-tool/deployment.yml`) is restricted to:

```yaml
rules:
  - apiGroups: [""]
    resources: ["namespaces", "pods", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
```

All create/patch/update/delete verbs and the old PVC/NetworkPolicy rules
were removed. You can verify the lockdown:

```bash
kubectl auth can-i create namespaces \
  --as=system:serviceaccount:orange-kuma:management-tool
# -> no
```

The Argo CD token is a dedicated read-only account (`role:readonly`,
`applications get/list`), and Gitea reads hit public repos. No path in
the tool can change platform state.

---

## 7. Configuration

All configuration is via environment variables (supplied by the platform
ConfigMap/Secret; all optional, missing ones just yield empty columns):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | HTTP listen port. |
| `GITEA_URL` | — | Gitea base URL for commit reads. |
| `GITEA_ORG` | `orange` | Org owning the provisioning repos. |
| `ARGOCD_API_URL` | `http://argocd-server.argocd.svc` | Argo CD REST API. |
| `ARGOCD_TOKEN` | — | Read-only Argo CD bearer token (mounted from a Secret, optional). |
| `SEMAPHORE_NEW_CUSTOMER_URL` | `SEMAPHORE_URL` fallback | Deep-link for the new-customer button. |
| `BUILD_VERSION` | `package.json` version | Shown in the UI; injected at image build. |

---

## 8. Container Image & CI/CD

### Image
`Dockerfile` — `node:20-alpine`, `npm ci --omit=dev`, runs
`node server.js` on port **4000**. `BUILD_VERSION` is a build arg
threaded to an env var so the running UI can display which build it is.

### Pipeline (`.drone.yml`)
A single Drone pipeline triggered on push and pull request to `main`:

- **build-and-push** (on push) — `plugins/docker` builds and pushes to
  the Gitea registry tagged `latest` and the 7-char commit SHA, passing
  `BUILD_VERSION` as a build arg. Registry/repo/credentials come from
  Drone secrets (`GITEA_REGISTRY`, `MGMT_IMAGE_REPO`,
  `GITEA_REGISTRY_USERNAME`, `GITEA_REGISTRY_PASSWORD`); push is
  `insecure: true` for the plain-HTTP internal registry.
- **build-dry-run** (on pull request) — builds the image without pushing,
  so PRs validate the Dockerfile without publishing.

The SHA tag is what Argo CD Image Updater keys on to roll new builds out
automatically (see the auto-update strategy in `project-cloud`).

---

## 9. Deployment

Deployed by the Orange Kuma platform's Phase 4 playbook
(`setup-cicd-pipeline.yml` in `project-cloud`) into the `orange-kuma`
namespace, exposed on NodePort **30087**. That phase also mints the
read-only Argo CD token and stores it in the `management-tool-argocd`
Secret, which the pod mounts as `ARGOCD_TOKEN`.

The authoritative Kubernetes manifest is
`k8s/management-tool/deployment.yml` in `project-cloud`.
`k8s/deployment-template.yaml` in this repo is a reference copy kept
alongside the source.

---

## 10. File Structure

```
orange-uptime-kuma-management-tool/
├── server.js                     # Express app: API + static serving
├── package.json                  # Node ≥20, express + k8s client
├── Dockerfile                    # node:20-alpine image
├── .drone.yml                    # build/push + PR dry-run pipeline
├── README.md                     # Quick-start
├── DOCUMENTATION.md              # This file
├── public/
│   ├── index.html                # Dashboard page
│   ├── app.js                    # Fetches /api/customers, renders table
│   └── style.css                 # Orange Kuma branding
└── k8s/
    └── deployment-template.yaml  # Reference copy of the k8s manifest
```
