import { type AssistantScope, SCOPE_TEXT } from "@svett/core";

import { frontendApiOf } from "./clerk-config.ts";

/** Escapes text for HTML, in an element or an attribute. */
export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** JSON that is safe inside a script element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");

/** The headers every sign-in page carries: never framed, never cached, never referred. */
export const PAGE_HEADERS = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #000; color: #f2f2f7; font: 100%/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 0.75rem; overflow-wrap: anywhere; }
p { margin: 0 0 1rem; color: #ebebf5cc; overflow-wrap: anywhere; }
fieldset { border: 0; margin: 1.5rem 0; padding: 0; }
legend { font-weight: 600; margin-bottom: 0.75rem; }
label { display: flex; gap: 0.75rem; align-items: flex-start; min-height: 2.75rem; padding: 0.75rem 1rem; margin-bottom: 0.5rem; background: #1c1c1e; border-radius: 0.75rem; cursor: pointer; }
input[type=checkbox] { width: 1.5rem; height: 1.5rem; margin: 0.1rem 0 0; flex: none; accent-color: #30d158; }
label strong { display: block; color: #f2f2f7; }
label span { display: block; color: #ebebf599; font-size: 0.95rem; }
button { display: block; width: 100%; min-height: 2.75rem; margin: 0 0 0.75rem; border: 0; border-radius: 0.75rem; font: inherit; font-weight: 600; padding: 0.75rem 1rem; cursor: pointer; }
#allow { background: #30d158; color: #000; }
#allow:disabled { background: #3a3a3c; color: #ebebf599; cursor: default; }
#deny { background: #2c2c2e; color: #f2f2f7; }
#signin { margin: 1rem 0; }
.note { font-size: 0.95rem; }
`;

const SCRIPT = `
const allow = document.getElementById("allow");
const deny = document.getElementById("deny");
const status = document.getElementById("status");
const who = document.getElementById("who");
const boxes = [...document.querySelectorAll("input[name=scope]")];
let signedIn = false;
const update = () => {
  allow.disabled = !signedIn || !boxes.some((box) => box.checked);
};
boxes.forEach((box) => box.addEventListener("change", update));
const send = async (body) => {
  const answer = await fetch(location.pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: REQUEST, ...body }),
  });
  const result = await answer.json().catch(() => ({}));
  if (answer.ok && typeof result.redirect === "string") {
    location.assign(result.redirect);
    return;
  }
  status.textContent = result.message || "svett could not finish this. Try again.";
  allow.disabled = false;
  deny.disabled = false;
};
deny.addEventListener("click", () => {
  deny.disabled = true;
  send({ decision: "deny", scopes: [] });
});
allow.addEventListener("click", async () => {
  allow.disabled = true;
  status.textContent = "Connecting…";
  const sessionToken = await window.Clerk.session.getToken();
  send({
    decision: "allow",
    scopes: boxes.filter((box) => box.checked).map((box) => box.value),
    sessionToken,
  });
});
window.startSignIn = async () => {
  const clerk = window.Clerk;
  await clerk.load();
  const show = () => {
    signedIn = Boolean(clerk.user && clerk.session);
    who.textContent = signedIn
      ? "Signed in to svett as " + (clerk.user.primaryEmailAddress?.emailAddress ?? "you") + "."
      : "Sign in to your svett account first.";
    document.getElementById("signin").hidden = signedIn;
    update();
  };
  if (!clerk.user) clerk.mountSignIn(document.getElementById("signin"), { routing: "virtual" });
  clerk.addListener(show);
  show();
};
`;

export interface ConsentPage {
  readonly clientName: string;
  readonly host: string;
  readonly offered: ReadonlyArray<AssistantScope>;
  /** The authorization request, sent back with the person's choice. */
  readonly request: Readonly<Record<string, string>>;
  readonly publishableKey: string | undefined;
}

/**
 * The page where the person signs in to svett and chooses what the app may do. Reading and
 * proposing are separate boxes, none ticked, and Allow stays off until one is.
 */
export const consentPage = (page: ConsentPage) => {
  const name = escapeHtml(page.clientName);
  const frontendApi =
    page.publishableKey === undefined ? undefined : frontendApiOf(page.publishableKey);
  const boxes = page.offered
    .map(
      (scope) => `<label><input type="checkbox" name="scope" value="${scope}">
<span><strong>${escapeHtml(SCOPE_TEXT[scope].title)}</strong><span>${escapeHtml(SCOPE_TEXT[scope].detail)}</span></span></label>`,
    )
    .join("\n");
  const signIn = frontendApi !== undefined && page.publishableKey !== undefined;
  const clerk = signIn
    ? `<p id="who">Opening sign-in…</p>\n<div id="signin"></div>`
    : `<p id="who">Sign-in to svett is not set up on this server yet, so nothing can connect.</p>`;
  // Loaded after the page's own script, which defines startSignIn.
  const clerkScript = signIn
    ? `<script async crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(page.publishableKey)}" src="https://${escapeHtml(frontendApi.host)}/npm/@clerk/clerk-js@5/dist/clerk.browser.js" onload="startSignIn()"></script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect ${name} to svett</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Connect ${name} to svett</h1>
<p>${name} asks to use your svett account. When you choose, svett sends you back to ${escapeHtml(page.host)}.</p>
${clerk}
<fieldset>
<legend>Choose what ${name} may do</legend>
${boxes}
</fieldset>
<p class="note">It never sees anyone else's data, and what your followers see stays as it is. You can revoke it any time under You, Connected apps.</p>
<button id="allow" type="button" disabled>Allow</button>
<button id="deny" type="button">Don't allow</button>
<p id="status" role="status" aria-live="polite"></p>
</main>
<script>const REQUEST = ${scriptJson(page.request)};${SCRIPT}</script>
${clerkScript}
</body>
</html>
`;
};

/** A page that says why svett cannot go on with a sign-in, without sending anyone anywhere. */
export const problemPage = (message: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>svett sign-in</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>svett cannot connect this app</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>
`;
