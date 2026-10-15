export const CLIENT_JS = String.raw`(() => {
  "use strict";
  document.documentElement.classList.add("js");

  const b64urlToBuf = (s) => {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const bufToB64url = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  document.addEventListener("submit", (e) => {
    const form = e.target;
    const msg = form.getAttribute("data-confirm") || (e.submitter && e.submitter.getAttribute("data-confirm"));
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    if (form.hasAttribute("data-passkey") && !form.dataset.passkeyDone) { e.preventDefault(); runPasskey(form); return; }
    if (form.dataset.busy) { e.preventDefault(); return; }
    form.dataset.busy = "1";
    setTimeout(() => { delete form.dataset.busy; }, 4000);
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    navigator.clipboard.writeText(btn.getAttribute("data-copy")).then(() => {
      const label = btn.textContent;
      btn.textContent = btn.getAttribute("data-copied") || "Copied";
      setTimeout(() => { btn.textContent = label; }, 1500);
    });
  });

  async function runPasskey(form) {
    const status = form.querySelector("[data-passkey-status]");
    const say = (t) => { if (status) status.textContent = t; };
    if (!window.PublicKeyCredential) { say(form.getAttribute("data-unsupported") || "This browser doesn't support passkeys."); return; }
    const raw = form.querySelector("script[type='application/json'][data-passkey-options]");
    if (!raw) return;
    const opts = JSON.parse(raw.textContent);
    try {
      let cred;
      if (form.getAttribute("data-passkey") === "create") {
        const pk = { ...opts, challenge: b64urlToBuf(opts.challenge), user: { ...opts.user, id: b64urlToBuf(opts.user.id) },
          excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })) };
        cred = await navigator.credentials.create({ publicKey: pk });
        const r = cred.response;
        form.querySelector("input[name=response]").value = JSON.stringify({
          id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type,
          response: { clientDataJSON: bufToB64url(r.clientDataJSON), attestationObject: bufToB64url(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] },
          clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
        });
      } else {
        const pk = { ...opts, challenge: b64urlToBuf(opts.challenge), allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })) };
        cred = await navigator.credentials.get({ publicKey: pk });
        const r = cred.response;
        form.querySelector("input[name=response]").value = JSON.stringify({
          id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type,
          response: { clientDataJSON: bufToB64url(r.clientDataJSON), authenticatorData: bufToB64url(r.authenticatorData), signature: bufToB64url(r.signature), userHandle: r.userHandle ? bufToB64url(r.userHandle) : undefined },
          clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment || undefined,
        });
      }
      form.dataset.passkeyDone = "1";
      form.requestSubmit ? form.requestSubmit() : form.submit();
    } catch (err) {
      say(form.getAttribute("data-cancelled") || "The passkey request was cancelled or timed out.");
    }
  }

  async function sha256Hex(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function solveAltcha(el) {
    const c = JSON.parse(el.getAttribute("data-altcha"));
    const form = el.closest("form");
    const input = form && form.querySelector("input[name=captcha]");
    const buttons = form ? form.querySelectorAll("button[type=submit], .btn[type=submit]") : [];
    buttons.forEach((b) => b.setAttribute("disabled", ""));
    el.dataset.state = "working";
    const started = performance.now();
    for (let n = 0; n <= c.maxnumber; n++) {
      if ((await sha256Hex(c.salt + n)) === c.challenge) {
        if (input) input.value = btoa(JSON.stringify({ algorithm: c.algorithm, challenge: c.challenge, number: n, salt: c.salt, signature: c.signature, took: Math.round(performance.now() - started) }));
        el.dataset.state = "done";
        const label = el.querySelector("[data-label]");
        if (label) label.textContent = el.getAttribute("data-done") || "Verified";
        buttons.forEach((b) => b.removeAttribute("disabled"));
        return;
      }
    }
    el.dataset.state = "failed";
  }


  document.querySelectorAll("input[data-suggest]").forEach((input) => {
    const target = document.getElementById(input.getAttribute("data-suggest-target"));
    const api = input.getAttribute("data-suggest");
    const base = input.getAttribute("data-suggest-base") || "";
    if (!target || !api) return;
    let timer = 0;
    let last = "";
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 4 || q === last) return;
        last = q;
        try {
          const r = await fetch(api + "?q=" + encodeURIComponent(q), { credentials: "same-origin", headers: { accept: "application/json" } });
          const j = await r.json();
          target.replaceChildren();
          if (!j.items || !j.items.length) { target.hidden = true; return; }
          const title = document.createElement("p");
          title.className = "hint";
          title.textContent = target.getAttribute("data-title") || "";
          const ul = document.createElement("ul");
          for (const a of j.items) {
            const li = document.createElement("li");
            const link = document.createElement("a");
            link.href = base + "/kb/" + encodeURIComponent(a.slug);
            link.target = "_blank";
            link.rel = "noopener";
            link.textContent = a.title;
            li.appendChild(link);
            ul.appendChild(li);
          }
          target.append(title, ul);
          target.hidden = false;
        } catch (_) { target.hidden = true; }
      }, 350);
    });
  });

  document.querySelectorAll("input[type=file][data-upload]").forEach((input) => {
    const form = input.closest("form");
    const list = document.getElementById(input.getAttribute("data-upload-list"));
    const start = input.getAttribute("data-upload");
    const extra = JSON.parse(input.getAttribute("data-upload-extra") || "{}");
    input.addEventListener("change", async () => {
      for (const file of Array.from(input.files || [])) {
        const row = document.createElement("li");
        row.textContent = file.name + " …";
        if (list) list.appendChild(row);
        try {
          const r = await fetch(start, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ ...extra, filename: file.name, content_type: file.type || "application/octet-stream", size: file.size }) });
          const j = await r.json();
          if (!r.ok) throw new Error(j.detail || j.code || "upload failed");
          const put = await fetch(j.upload.url, { method: "PUT", headers: j.upload.headers, body: file });
          if (!put.ok) throw new Error("upload failed");
          const done = await fetch(start + "/" + j.attachment_id + "/complete", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(extra) });
          const dj = await done.json();
          if (!done.ok) throw new Error(dj.detail || dj.code || "rejected");
          const hidden = document.createElement("input");
          hidden.type = "hidden"; hidden.name = "attachment_ids"; hidden.value = j.attachment_id;
          form.appendChild(hidden);
          row.textContent = file.name + " ✓";
        } catch (err) {
          row.textContent = file.name + " ✗ " + err.message;
        }
      }
      input.value = "";
    });
  });

  document.querySelectorAll("[data-altcha]").forEach((el) => { solveAltcha(el); });
  document.querySelectorAll("form[data-passkey][data-autostart]").forEach((f) => { if (window.PublicKeyCredential) runPasskey(f); });
})();
`;
