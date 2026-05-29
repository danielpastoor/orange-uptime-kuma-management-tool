"use strict";

// Read-only customer health dashboard. No provisioning happens here —
// it aggregates the cluster, Argo CD and Gitea, and links out to
// Semaphore for creating new customers.

function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("nl-NL", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

// Minimal HTML escaper to prevent XSS from cluster/Git-sourced strings.
function esc(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function podBadge(cluster) {
    const phase = cluster.podPhase || "Unknown";
    const cls =
        phase === "Running" ? "badge-running" :
        phase === "Pending" ? "badge-pending" : "badge-failed";
    const ready = cluster.readyReplicas ?? 0;
    const desired = cluster.desiredReplicas ?? "?";
    const restarts = cluster.restarts ? ` · ${cluster.restarts}× restart` : "";
    return `<span class="badge ${cls}">${esc(phase)}</span>` +
        `<span class="muted"> ${esc(String(ready))}/${esc(String(desired))}${esc(restarts)}</span>`;
}

function argoBadge(argo) {
    if (!argo || (!argo.sync && !argo.health)) {
        return '<span class="muted">n.v.t.</span>';
    }
    const sync = argo.sync || "Unknown";
    const health = argo.health || "Unknown";
    const syncCls = sync === "Synced" ? "badge-running" : "badge-pending";
    const healthCls =
        health === "Healthy" ? "badge-running" :
        health === "Progressing" ? "badge-pending" : "badge-failed";
    return `<span class="badge ${syncCls}">${esc(sync)}</span> ` +
        `<span class="badge ${healthCls}">${esc(health)}</span>`;
}

function commitCell(commit) {
    if (!commit) return '<span class="muted">—</span>';
    const sha = commit.sha ? `<code>${esc(commit.sha)}</code> ` : "";
    return `${sha}${esc(commit.message || "")}` +
        `<br><span class="muted">${esc(commit.author || "")} · ${fmtDate(commit.date)}</span>`;
}

function laneBadge(lane) {
    return lane === "ops"
        ? '<span class="badge badge-ops">ops · test</span>'
        : '<span class="badge badge-sales">sales</span>';
}

async function loadCustomers() {
    const tbody = document.getElementById("customers-body");
    try {
        const res = await fetch("/api/customers");
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || res.statusText);
        }
        const customers = await res.json();

        if (!customers.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nog geen klanten geprovisioned.</td></tr>';
            return;
        }

        tbody.innerHTML = customers.map(c => `
            <tr>
                <td><strong>${esc(c.slug || "—")}</strong><br><span class="muted">${esc(c.namespace)}</span></td>
                <td>${laneBadge(c.provisionedBy)}</td>
                <td>${esc(c.email || "—")}</td>
                <td>${podBadge(c.cluster || {})}</td>
                <td>${argoBadge(c.argocd)}</td>
                <td>${commitCell(c.commit)}</td>
                <td>${fmtDate(c.createdAt)}</td>
            </tr>
        `).join("");
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color:#dc3545">Fout bij laden: ${esc(String(err.message || err))}</td></tr>`;
    }
}

// Wire the "new customer" deep-link to the Semaphore template UI.
fetch("/api/config")
    .then(r => r.json())
    .then(({ semaphoreNewCustomerUrl }) => {
        const btn = document.getElementById("new-customer-btn");
        if (semaphoreNewCustomerUrl) {
            btn.href = semaphoreNewCustomerUrl;
        } else {
            btn.classList.add("disabled");
            btn.removeAttribute("href");
            btn.title = "Semaphore-URL niet geconfigureerd";
        }
    })
    .catch(() => {});

fetch("/api/version")
    .then(r => r.json())
    .then(({ version }) => {
        document.getElementById("build-version").textContent = `v${version}`;
    })
    .catch(() => {});

loadCustomers();
// Auto-refresh the read-only view every 15s.
setInterval(loadCustomers, 15000);
