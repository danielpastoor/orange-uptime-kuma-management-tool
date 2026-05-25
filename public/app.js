"use strict";

function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("nl-NL", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

function setStatus(msg, type) {
    const el = document.getElementById("deploy-status");
    el.textContent = msg;
    el.className = type === "ok" ? "status-ok" : type === "err" ? "status-err" : "";
}

async function loadCustomers() {
    const tbody = document.getElementById("customers-body");
    try {
        const res = await fetch("/api/customers");
        const customers = await res.json();

        if (!customers.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nog geen klanten gedeployd.</td></tr>';
            return;
        }

        tbody.innerHTML = customers.map(c => `
            <tr data-id="${c.id}">
                <td><strong>${esc(c.name)}</strong></td>
                <td>${esc(c.email)}</td>
                <td>${esc(c.company || "—")}</td>
                <td>${c.domain ? `<a href="http://${esc(c.domain)}" target="_blank">${esc(c.domain)}</a>` : "—"}</td>
                <td>${fmtDate(c.deployed_at)}</td>
                <td><span class="badge badge-${c.status}">${c.status === "running" ? "✅ Actief" : "🛑 Gestopt"}</span></td>
                <td>
                    ${c.status === "running"
                        ? `<button class="btn btn-danger" onclick="stopCustomer('${c.id}')">Stoppen</button>`
                        : "—"
                    }
                </td>
            </tr>
        `).join("");
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color:#dc3545">Fout bij laden: ${esc(String(err))}</td></tr>`;
    }
}

// Minimal HTML escaper to prevent XSS
function esc(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function stopCustomer(id) {
    if (!confirm("Weet je zeker dat je deze omgeving wilt stoppen?")) return;
    const btn = document.querySelector(`tr[data-id="${id}"] .btn-danger`);
    if (btn) { btn.disabled = true; btn.textContent = "Bezig…"; }

    try {
        const res = await fetch(`/api/customers/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        await loadCustomers();
    } catch (err) {
        alert("Stoppen mislukt: " + err.message);
        await loadCustomers();
    }
}

window.stopCustomer = stopCustomer;

document.getElementById("deploy-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("deploy-btn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Deploying…';
    setStatus("", "");

    const body = {
        name:    document.getElementById("name").value.trim(),
        email:   document.getElementById("email").value.trim(),
        company: document.getElementById("company").value.trim(),
        domain:  document.getElementById("domain").value.trim(),
    };

    try {
        const res = await fetch("/api/deploy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error + (data.detail ? ": " + data.detail : ""));

        setStatus("✅ Omgeving succesvol aangemaakt (ID: " + data.id + ")", "ok");
        e.target.reset();
        await loadCustomers();
    } catch (err) {
        setStatus("❌ Fout: " + err.message, "err");
    } finally {
        btn.disabled = false;
        btn.innerHTML = "🚀 Deploy omgeving";
    }
});

loadCustomers();
