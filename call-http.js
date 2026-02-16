// --- HTTP helpers ---

const {  API_KEY } = require("./app-config");

async function httpGet(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json", "api-key": API_KEY },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${url} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function httpPost(url, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": API_KEY },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${url} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function httpPut(url, data) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "api-key": API_KEY },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PUT ${url} failed (${res.status}): ${body}`);
  }
  return res.json();
}

module.exports = { httpGet, httpPost, httpPut };
