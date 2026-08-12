const PAGE_STYLE = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; line-height: 1.6; }
  h1, h2 { line-height: 1.2; }
  a { color: inherit; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  nav { display: flex; flex-wrap: wrap; gap: 16px; margin: 24px 0 36px; }
  .muted { opacity: .78; }
`;

const layout = ({title, body}) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Lana Design</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <header>
    <strong>Lana Design</strong>
    <nav aria-label="Bright Evidence information">
      <a href="/plugin">Bright Evidence</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="/support">Support</a>
    </nav>
  </header>
  <main>${body}</main>
  <footer><p class="muted">Bright Evidence is published by Lana Design.</p></footer>
</body>
</html>`;

const pluginPage = layout({
  title: 'Bright Evidence',
  body: `
    <h1>Bright Evidence</h1>
    <p>Bright Evidence helps ChatGPT workflows turn caller-provided public-source research into a deterministic, provenance-preserving evidence bundle.</p>
    <p>The read-only <code>normalize_evidence</code> tool normalizes URLs and factual claims, merges compatible duplicates, preserves unresolved conflicts, scores retained evidence, and reports malformed items. The MCP server does not browse the web, write to a database, call another model, or execute instructions found in source content.</p>
    <h2>Public MCP endpoint</h2>
    <p><code>https://video.lanadesign.tech/mcp</code></p>
    <h2>Publisher</h2>
    <p>Lana Design. See the <a href="/privacy">Privacy Policy</a>, <a href="/terms">Terms of Service</a>, and <a href="/support">Support</a>.</p>
  `,
});

const privacyPage = layout({
  title: 'Privacy Policy',
  body: `
    <h1>Bright Evidence Privacy Policy</h1>
    <p><strong>Effective:</strong> August 13, 2026.</p>
    <p>This policy describes how Lana Design handles data when Bright Evidence is invoked through ChatGPT or another compatible MCP client.</p>

    <h2>Personal data and data categories</h2>
    <p>Bright Evidence receives the tool input supplied by the invoking client. That input can include a subject name, factual claims, public URLs, source titles, publisher or author names, publication dates, short excerpts, and optional typed values. Users should provide only public-source research needed for evidence normalization.</p>
    <p>The service also processes limited operational metadata needed to serve and troubleshoot a request, such as request ID, HTTP method, sanitized path, response status, duration, and infrastructure connection metadata such as an IP address that may be handled by the reverse proxy or hosting provider.</p>

    <h2>Purpose</h2>
    <p>Tool input is used only to validate, normalize, deduplicate, score, and return evidence and conflict information requested by the user. Operational metadata is used for service security, reliability, abuse prevention, and troubleshooting.</p>

    <h2>Recipients and processors</h2>
    <p>The MCP application does not send evidence to an additional model, advertising service, or data broker. It returns the result to the invoking MCP client. When Bright Evidence is used in ChatGPT, OpenAI processes the conversation and tool exchange under OpenAI's own terms and privacy notices. Hosting and reverse-proxy providers may process limited connection and operational metadata as infrastructure processors.</p>

    <h2>Retention</h2>
    <p>Bright Evidence does not persist evidence request bodies or EvidenceBundle results. Application-level retention for those inputs and results is <strong>0 days (zero days)</strong> beyond in-memory request processing.</p>
    <p>Application request logs exclude claims, excerpts, full request bodies, authentication secrets, and raw query strings. Operational infrastructure logs may be retained for security and reliability; Lana Design's publication configuration requires those reverse-proxy/hosting logs to be retained for no more than <strong>30 days</strong>.</p>

    <h2>Data minimization and restricted data</h2>
    <p>Do not submit passwords or other credentials, payment-card data, protected health information (PHI), government identifiers, or other sensitive information that is not necessary for public-source evidence normalization.</p>

    <h2>User controls</h2>
    <p>You control which public-source evidence is sent to Bright Evidence and may stop using the plugin at any time. Because evidence bodies and results are not persisted by the MCP application, there is normally no stored evidence record for Lana Design to delete. For questions about operational metadata, privacy, or a suspected data issue, use the support channel below.</p>

    <h2>Contact</h2>
    <p>See <a href="/support">Bright Evidence Support</a> to contact Lana Design.</p>
  `,
});

const termsPage = layout({
  title: 'Terms of Service',
  body: `
    <h1>Bright Evidence Terms of Service</h1>
    <p><strong>Effective:</strong> August 13, 2026.</p>
    <p>Bright Evidence is a read-only evidence-normalization utility provided by Lana Design. By using it, you agree to these terms.</p>

    <h2>Permitted use</h2>
    <p>Use Bright Evidence to process factual claims and provenance from public sources or public URLs you are authorized to use. You are responsible for the material you submit and for complying with applicable law and third-party rights.</p>

    <h2>Prohibited use</h2>
    <p>Do not use Bright Evidence to obtain or process stolen credentials, payment-card data, protected health information, government identifiers, or material acquired by bypassing authentication, paywalls, access controls, or other technical restrictions. Do not use it to fabricate sources or falsely represent normalized evidence as independently verified fact.</p>

    <h2>Service behavior</h2>
    <p>Normalization is deterministic but does not establish that a source or claim is true. Conflicts may remain unresolved and should be reviewed against the cited sources. The service may reject malformed or unsupported inputs and may apply request-size, timeout, and rate limits.</p>

    <h2>Availability and changes</h2>
    <p>The service is provided on an as-available basis. Lana Design may update or discontinue the service, subject to applicable platform requirements. Material policy changes will be reflected on these public pages.</p>

    <h2>Support</h2>
    <p>Questions can be raised through <a href="/support">Bright Evidence Support</a>.</p>
  `,
});

const supportPage = layout({
  title: 'Support',
  body: `
    <h1>Bright Evidence Support</h1>
    <p>Bright Evidence is maintained by Lana Design.</p>
    <p>For bugs, privacy questions, plugin issues, or security reports, open an issue in the project repository:</p>
    <p><a href="https://github.com/nguyentuanson27-netizen/bright-profile-video-automation/issues">github.com/nguyentuanson27-netizen/bright-profile-video-automation/issues</a></p>
    <p>When reporting a problem, do not include credentials, private source material, full sensitive request bodies, payment information, PHI, or government identifiers.</p>
  `,
});

const PAGES = new Map([
  ['/plugin', pluginPage],
  ['/privacy', privacyPage],
  ['/terms', termsPage],
  ['/support', supportPage],
]);

export const getPublicPage = (pathname) => {
  const body = PAGES.get(pathname);
  if (!body) return null;
  return {status: 200, contentType: 'text/html; charset=utf-8', body};
};

export const getOpenAiChallenge = (env) => {
  const token = typeof env.OPENAI_APPS_CHALLENGE_TOKEN === 'string'
    ? env.OPENAI_APPS_CHALLENGE_TOKEN
    : '';
  if (!token.trim()) return null;
  return {status: 200, contentType: 'text/plain; charset=utf-8', body: token};
};
