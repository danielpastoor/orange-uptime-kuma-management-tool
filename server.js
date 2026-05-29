"use strict";

// Orange Kuma Management Tool — read-only customer health dashboard.
//
// This tool no longer provisions customers. Provisioning is owned by
// Semaphore (Ansible -> Gitea -> Argo CD GitOps). The dashboard is a
// read-only aggregator over three sources of truth:
//   - Kubernetes API : namespaces / deployments / pods (in-cluster SA)
//   - Argo CD API     : sync + health of the two umbrella Applications
//   - Gitea API       : latest commit per customer manifest file
//
// It mutates nothing. The "Nieuwe klant aanmaken" button deep-links to
// the Semaphore template UI where sales actually create customers.

const express = require("express");
const path = require("path");
const k8s = require("@kubernetes/client-node");

const pkg = require("./package.json");

const app = express();
const PORT = process.env.PORT || 4000;
const BUILD_VERSION = process.env.BUILD_VERSION || pkg.version;

// --- External source-of-truth endpoints (from the ConfigMap/Secret) ---
const GITEA_URL = (process.env.GITEA_URL || "").replace(/\/$/, "");
const GITEA_ORG = process.env.GITEA_ORG || "orange";
// In-cluster Argo CD API. Defaults to the http service inside argocd ns.
const ARGOCD_API_URL = (process.env.ARGOCD_API_URL || "http://argocd-server.argocd.svc").replace(/\/$/, "");
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN || "";
// Full deep-link to the Semaphore sales template (project/template ids
// are environment-specific, so the whole URL is configurable). Falls
// back to the Semaphore base URL if the deep-link isn't provided.
const SEMAPHORE_NEW_CUSTOMER_URL =
    process.env.SEMAPHORE_NEW_CUSTOMER_URL || process.env.SEMAPHORE_URL || "";

// Map a provisioning lane to the Gitea repo + Argo CD Application that
// owns it. Sales customers live in customer-instances; ops/test ones in
// test-customers. The umbrella Application name matches the repo name.
const LANE = {
    sales: { repo: "customer-instances", app: "customer-instances" },
    ops: { repo: "test-customers", app: "test-customers" },
};

const kc = new k8s.KubeConfig();
// Loads from KUBECONFIG env, ~/.kube/config, or the in-cluster SA.
try {
    kc.loadFromDefault();
} catch (_) {
    console.warn("No Kubernetes config found — cluster reads will fail at runtime");
}

const k8sApps = kc.makeApiClient(k8s.AppsV1Api);
const k8sCore = kc.makeApiClient(k8s.CoreV1Api);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * Fetch the Argo CD sync + health for one Application. Best-effort:
 * returns nulls (never throws) so the dashboard renders even when Argo
 * CD is unreachable or no token is configured.
 * @param {string} name Argo CD Application name
 * @returns {Promise<{sync: (string|null), health: (string|null), syncedAt: (string|null)}>} status
 */
async function getArgoAppStatus(name) {
    const empty = { sync: null, health: null, syncedAt: null };
    if (!ARGOCD_TOKEN) {
        return empty;
    }
    try {
        const res = await fetch(`${ARGOCD_API_URL}/api/v1/applications/${encodeURIComponent(name)}`, {
            headers: { Authorization: `Bearer ${ARGOCD_TOKEN}` },
        });
        if (!res.ok) {
            return empty;
        }
        const app = await res.json();
        return {
            sync: app?.status?.sync?.status || null,
            health: app?.status?.health?.status || null,
            syncedAt: app?.status?.operationState?.finishedAt || null,
        };
    } catch (_) {
        return empty;
    }
}

/**
 * Fetch the latest Gitea commit touching a customer's manifest file.
 * Best-effort: returns null on any error so a single bad read doesn't
 * break the whole dashboard.
 * @param {string} repo Gitea repo (customer-instances / test-customers)
 * @param {string} slug Customer slug
 * @returns {Promise<({author: string, message: string, sha: string, date: string}|null)>} commit info
 */
async function getLatestCommit(repo, slug) {
    if (!GITEA_URL) {
        return null;
    }
    try {
        const url =
            `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/${repo}/commits` +
            `?path=${encodeURIComponent(`customers/${slug}.yaml`)}&limit=1`;
        const res = await fetch(url);
        if (!res.ok) {
            return null;
        }
        const commits = await res.json();
        if (!Array.isArray(commits) || commits.length === 0) {
            return null;
        }
        const c = commits[0];
        return {
            author: c?.commit?.author?.name || c?.author?.login || "—",
            message: (c?.commit?.message || "").split("\n")[0],
            sha: (c?.sha || "").slice(0, 7),
            date: c?.commit?.author?.date || null,
        };
    } catch (_) {
        return null;
    }
}

/**
 * Read cluster state (deployment replicas + pod phase/restarts) for one
 * customer namespace. Best-effort per field.
 * @param {string} namespace Customer namespace
 * @returns {Promise<object>} cluster state summary
 */
async function getClusterState(namespace) {
    const state = {
        desiredReplicas: null,
        readyReplicas: null,
        podPhase: "Unknown",
        restarts: 0,
    };

    try {
        const dep = await k8sApps.readNamespacedDeployment("kuma", namespace);
        const spec = dep.body?.spec || {};
        const status = dep.body?.status || {};
        state.desiredReplicas = spec.replicas ?? null;
        state.readyReplicas = status.readyReplicas ?? 0;
    } catch (_) {
        // deployment not created yet; leave nulls
    }

    try {
        const pods = await k8sCore.listNamespacedPod(
            namespace, undefined, undefined, undefined, undefined, "app=orange-kuma"
        );
        const items = pods.body?.items || [];
        if (items.length > 0) {
            // Surface the first pod's phase + total container restarts.
            state.podPhase = items[0]?.status?.phase || "Unknown";
            state.restarts = items.reduce((sum, p) => {
                const cs = p?.status?.containerStatuses || [];
                return sum + cs.reduce((s, c) => s + (c.restartCount || 0), 0);
            }, 0);
        } else {
            state.podPhase = "Pending";
        }
    } catch (_) {
        // pods unreadable; leave defaults
    }

    return state;
}

app.get("/api/version", (req, res) => {
    res.json({ version: BUILD_VERSION });
});

// Front-end config: the deep-link target for the "new customer" button.
app.get("/api/config", (req, res) => {
    res.json({ semaphoreNewCustomerUrl: SEMAPHORE_NEW_CUSTOMER_URL });
});

// Aggregate read-only view of every provisioned customer instance.
app.get("/api/customers", async (req, res) => {
    let namespaces;
    try {
        // Customer namespaces carry app=orange-kuma AND a `customer`
        // label. Selecting on `customer` (presence) excludes the
        // management-tool's own orange-kuma namespace.
        const result = await k8sCore.listNamespace(
            undefined, undefined, undefined, undefined, "app=orange-kuma,customer"
        );
        namespaces = result.body?.items || [];
    } catch (err) {
        console.error("Failed to list namespaces:", err.body || err.message);
        return res.status(500).json({ error: "Failed to read namespaces from the cluster" });
    }

    // Argo CD umbrella Applications are shared across customers in a
    // lane, so fetch each once and reuse for every customer in it.
    const [salesApp, opsApp] = await Promise.all([
        getArgoAppStatus(LANE.sales.app),
        getArgoAppStatus(LANE.ops.app),
    ]);
    const argoByLane = { sales: salesApp, ops: opsApp };

    const customers = await Promise.all(
        namespaces.map(async (ns) => {
            const labels = ns.metadata?.labels || {};
            const annotations = ns.metadata?.annotations || {};
            const slug = labels.customer;
            const provisionedBy = labels["provisioned-by"] === "ops" ? "ops" : "sales";
            const lane = LANE[provisionedBy];

            const [cluster, commit] = await Promise.all([
                getClusterState(ns.metadata.name),
                getLatestCommit(lane.repo, slug),
            ]);

            return {
                slug,
                namespace: ns.metadata.name,
                provisionedBy,
                email: annotations["orange-kuma/customer-email"] || "—",
                createdAt: ns.metadata?.creationTimestamp || null,
                repo: lane.repo,
                cluster,
                argocd: argoByLane[provisionedBy],
                commit,
            };
        })
    );

    customers.sort((a, b) => (a.slug || "").localeCompare(b.slug || ""));
    res.json(customers);
});

app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Orange Kuma customer health dashboard running on http://localhost:${PORT}`);
});
