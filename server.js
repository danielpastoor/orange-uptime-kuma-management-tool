"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const k8s = require("@kubernetes/client-node");

const app = express();
const PORT = process.env.PORT || 4000;
const IMAGE = process.env.KUMA_IMAGE || "orange-uptime-kuma:latest";
const NAMESPACE = process.env.K8S_NAMESPACE || "default";

const dbPath = path.join(__dirname, "data", "customers.db");
require("fs").mkdirSync(path.join(__dirname, "data"), { recursive: true });
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    company     TEXT,
    domain      TEXT,
    deployed_at TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running'
  )
`);

const kc = new k8s.KubeConfig();
// Loads from KUBECONFIG env, ~/.kube/config, or in-cluster service account

try {
    kc.loadFromDefault();
} catch (_) {
    console.warn("No Kubernetes config found — K8s operations will fail at runtime");
}

const k8sApps = kc.makeApiClient(k8s.AppsV1Api);
const k8sCore = kc.makeApiClient(k8s.CoreV1Api);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function buildDeployment(customer) {
    return {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
            name: `kuma-${customer.id}`,
            namespace: NAMESPACE,
            labels: { app: "orange-uptime-kuma", customer: customer.id },
        },
        spec: {
            replicas: 1,
            selector: { matchLabels: { app: "orange-uptime-kuma", customer: customer.id } },
            template: {
                metadata: { labels: { app: "orange-uptime-kuma", customer: customer.id } },
                spec: {
                    containers: [
                        {
                            name: "kuma",
                            image: IMAGE,
                            ports: [ { containerPort: 3001 } ],
                            env: [
                                { name: "CUSTOMER_NAME",   value: customer.name },
                                { name: "CUSTOMER_ID",     value: customer.id },
                                { name: "CUSTOMER_EMAIL",  value: customer.email },
                                { name: "CUSTOMER_DOMAIN", value: customer.domain || "" },
                            ],
                            volumeMounts: [
                                { name: "data", mountPath: "/app/data" },
                            ],
                        },
                    ],
                    volumes: [
                        {
                            name: "data",
                            emptyDir: {},
                        },
                    ],
                },
            },
        },
    };
}

function buildService(customer) {
    return {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
            name: `kuma-${customer.id}`,
            namespace: NAMESPACE,
            labels: { app: "orange-uptime-kuma", customer: customer.id },
        },
        spec: {
            selector: { app: "orange-uptime-kuma", customer: customer.id },
            ports: [ { port: 3001, targetPort: 3001 } ],
            type: "ClusterIP",
        },
    };
}


app.get("/api/customers", (req, res) => {
    const rows = db.prepare("SELECT * FROM customers ORDER BY deployed_at DESC").all();
    res.json(rows);
});

app.post("/api/deploy", async (req, res) => {
    const { name, email, company, domain } = req.body;

    if (!name || !email) {
        return res.status(400).json({ error: "name and email are required" });
    }

    const id = crypto.randomBytes(4).toString("hex");
    const customer = { id, name, email, company: company || "", domain: domain || "" };

    try {
        await k8sApps.createNamespacedDeployment({ namespace: NAMESPACE, body: buildDeployment(customer) });
        await k8sCore.createNamespacedService({ namespace: NAMESPACE, body: buildService(customer) });
    } catch (err) {
        console.error("Kubernetes error:", err.body || err.message);
        return res.status(500).json({ error: "Failed to create Kubernetes resources", detail: err.body?.message || err.message });
    }

    db.prepare(
        "INSERT INTO customers (id, name, email, company, domain, deployed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, name, email, customer.company, customer.domain, new Date().toISOString(), "running");

    res.status(201).json({ id, message: "Deployment created" });
});

app.delete("/api/customers/:id", async (req, res) => {
    const { id } = req.params;
    const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
    
    if (!row) {
        return res.status(404).json({ error: "Customer not found" });
    }

    try {
        await k8sApps.deleteNamespacedDeployment({ name: `kuma-${id}`, namespace: NAMESPACE });
        await k8sCore.deleteNamespacedService({ name: `kuma-${id}`, namespace: NAMESPACE });
    } catch (err) {
        console.error("Kubernetes error on delete:", err.body || err.message);
        // Continue and mark as stopped even if K8s resources were already gone
    }

    db.prepare("UPDATE customers SET status = 'stopped' WHERE id = ?").run(id);
    res.json({ message: "Instance stopped" });
});

app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Orange Uptime Kuma Dashboard running on http://localhost:${PORT}`);
});
