---
title: SaveMyContext
description: Save AI conversations and agent context handoffs into a backend you control.
landing: true
---

<section class="hero">
  <div class="hero-copy">
    <p class="eyebrow">Private AI memory for people who use more than one model</p>
    <h1>SaveMyContext</h1>
    <p class="hero-lede">
      Capture conversations from ChatGPT, Gemini, Grok, Codex, and Claude Code, then turn them into searchable notes,
      graph views, dashboards, and an Obsidian-friendly Markdown vault.
    </p>
    <div class="hero-actions">
      <a class="button primary" href="{{ '/getting-started/' | relative_url }}">Install SaveMyContext</a>
      <a class="button secondary" href="{{ '/using-save-my-context/' | relative_url }}">Read the docs</a>
    </div>
  </div>
  <div class="hero-visual" aria-label="SaveMyContext install and vault preview">
    <div class="terminal">
      <div class="terminal-title">Terminal</div>
{% highlight bash %}uv tool install savemycontext
smc install --remote

# Paste the emitted smc_conn_1_... string
# into the extension settings.{% endhighlight %}
    </div>
    <div class="vault-preview">
      <div class="vault-title">Markdown vault</div>
{% highlight text %}SaveMyContext/
  Journal/
  Factual/
  Ideas/
  Dashboards/
    To-Do List.md{% endhighlight %}
    </div>
  </div>
</section>

<section class="section">
  <h2>One extension, two backend paths</h2>
  <p class="section-lede">
    Use the managed backend when you want the hosted service, or run the same core backend yourself.
    The extension connects through the same API contract either way.
  </p>
  <div class="grid two">
    <div class="card accent">
      <h3>Hosted backend</h3>
      <p>
        A managed SaveMyContext backend can handle account management, paid plans, hosted storage,
        and service operations while preserving the extension's normal connection flow.
      </p>
    </div>
    <div class="card accent">
      <h3>Self-hosted backend</h3>
      <p>
        Install the open backend with <code>uv tool install savemycontext</code>, run <code>smc install</code>,
        and keep the database and Markdown vault on infrastructure you control.
      </p>
    </div>
  </div>
  <div class="button-row">
    <a class="button secondary" href="{{ '/service-options/' | relative_url }}">Compare service options</a>
    <a class="button secondary" href="{{ '/remote-access/' | relative_url }}">Set up remote access</a>
  </div>
</section>

<section class="section">
  <h2>What it captures</h2>
  <div class="grid">
    <div class="card">
      <h3>AI chat history</h3>
      <p>Sync conversations from ChatGPT, Gemini, Grok, Codex, and Claude Code into one private archive.</p>
    </div>
    <div class="card">
      <h3>Saved pages and selections</h3>
      <p>Store source material alongside the conversations that made it useful.</p>
    </div>
    <div class="card">
      <h3>Structured notes</h3>
      <p>Classify sessions into journal, factual, ideas, to-do, and custom piles.</p>
    </div>
  </div>
</section>

<section class="section">
  <h2>Install in minutes</h2>
  <p class="section-lede">
    The fastest self-hosted setup installs the backend as a user service and prints a pasteable connection string.
  </p>
  <div class="install-panel">
    <div class="install-copy">
      <h3>Backend</h3>
      <p>
        Run the backend locally for one machine, or use remote mode so several browser profiles and devices can
        connect to the same host.
      </p>
    </div>
    <div class="terminal">
      <div class="terminal-title">Install commands</div>
{% highlight bash %}uv tool install savemycontext
smc install --remote
smc share{% endhighlight %}
    </div>
  </div>
  <div class="button-row">
    <a class="button primary" href="{{ '/getting-started/' | relative_url }}">Follow the full guide</a>
    <a class="button secondary" href="{{ '/security-and-access/' | relative_url }}">Review security</a>
  </div>
</section>

<section class="section">
  <h2>Documentation</h2>
  <div class="grid">
    <div class="card">
      <h3><a href="{{ '/getting-started/' | relative_url }}">Getting Started</a></h3>
      <p>Install the backend, load the extension, and complete the first sync.</p>
    </div>
    <div class="card">
      <h3><a href="{{ '/using-save-my-context/' | relative_url }}">Using SaveMyContext</a></h3>
      <p>Understand capture behavior, sync settings, source captures, and provider support.</p>
    </div>
    <div class="card">
      <h3><a href="{{ '/vault-and-storage/' | relative_url }}">Vault and Storage</a></h3>
      <p>See where Markdown files are written and how the local vault is organized.</p>
    </div>
    <div class="card">
      <h3><a href="{{ '/dashboard-and-search/' | relative_url }}">Dashboard and Search</a></h3>
      <p>Use the dashboard, quick search, graph views, and pile pages.</p>
    </div>
    <div class="card">
      <h3><a href="{{ '/remote-access/' | relative_url }}">Remote Access</a></h3>
      <p>Connect additional devices with connection strings and managed exposure.</p>
    </div>
    <div class="card">
      <h3><a href="{{ '/troubleshooting/' | relative_url }}">Troubleshooting</a></h3>
      <p>Recover from token, extension, backend, and provider capture issues.</p>
    </div>
  </div>
</section>
