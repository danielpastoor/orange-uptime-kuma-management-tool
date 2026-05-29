# Orange Kuma Management Tool

A branded, **read-only customer health dashboard** for the Orange Kuma
hosting platform. It shows every provisioned customer's Uptime Kuma
instance in one place — pod health, Argo CD sync/health, and the latest
GitOps commit — and deep-links staff into Semaphore to create new
customers.

> This tool **does not provision customers** and **never writes** to the
> cluster. Provisioning is owned by Semaphore (Ansible → Gitea → Argo CD).
> See [`DOCUMENTATION.md`](DOCUMENTATION.md) for detail and the
> `project-cloud` repository for the full platform.

## What it shows

One row per `customer-<slug>` namespace, aggregating three sources:

- **Cluster** (Kubernetes API) — pod phase, restart count, deployment
  replicas, namespace age, customer + `provisioned-by` labels, email.
- **Argo CD** (Argo CD REST API) — sync status and health of the lane's
  umbrella Application.
- **GitOps** (Gitea API) — latest commit (author, message, sha, time) on
  the customer's `customers/<slug>.yaml` manifest.

A **"Nieuwe klant aanmaken"** button deep-links to the Semaphore sales
template. The page auto-refreshes every 15 seconds.

## Architecture

```
Browser ──► Express (server.js, :4000)
               ├─► Kubernetes API   (in-cluster ServiceAccount, read-only)
               ├─► Argo CD REST API (bearer token, read-only)
               └─► Gitea API        (public repos, no token)
```

All three integrations are best-effort (wrapped in try/catch): the
dashboard still renders if any backend is briefly unreachable.

## Running locally

```bash
npm install
# Point at your platform endpoints (or rely on an in-cluster SA when
# deployed). All are optional — missing ones just yield empty columns.
export GITEA_URL="http://10.24.36.10:30080"
export GITEA_ORG="orange"
export ARGOCD_API_URL="http://argocd-server.argocd.svc"
export ARGOCD_TOKEN="<read-only argocd token>"
export SEMAPHORE_NEW_CUSTOMER_URL="http://10.24.36.10:30084/project/1/template/1"
npm start            # http://localhost:4000
```

## Deployment

Deployed to the `orange-kuma` namespace and exposed on NodePort `30087`
by the Orange Kuma platform. The Kubernetes manifest (Deployment,
Service, read-only ServiceAccount/ClusterRole, ConfigMap, Argo CD token
Secret) lives in `project-cloud` at `k8s/management-tool/deployment.yml`;
`k8s/deployment-template.yaml` in this repo is a reference copy.

Images are built and pushed to the Gitea registry by Drone (`.drone.yml`)
on every push to `main`, tagged `latest` and the 7-char commit SHA.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | HTTP listen port |
| `GITEA_URL` | — | Gitea base URL for commit reads |
| `GITEA_ORG` | `orange` | Gitea org owning the provisioning repos |
| `ARGOCD_API_URL` | `http://argocd-server.argocd.svc` | Argo CD REST API |
| `ARGOCD_TOKEN` | — | Read-only Argo CD bearer token |
| `SEMAPHORE_NEW_CUSTOMER_URL` | — | Deep-link for the "new customer" button |
| `BUILD_VERSION` | `package.json` version | Shown in the UI; set at build time |
