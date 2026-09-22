import { expect, test } from "@playwright/test";

const base = process.env.SMC_WORKSPACE_TEST_URL;
test.skip(
  !base,
  "Run only against an explicitly supplied disposable workspace server.",
);

test("shared workspace captures, reviews, remembers, and completes tasks on desktop and mobile", async ({
  page,
  request,
}) => {
  const key = crypto.randomUUID();
  await request.post(`${base}/api/v1/workspace/captures`, {
    data: {
      key,
      title: "A more thoughtful home lab",
      body: "We decided to keep the backup service independent.\nMy idea is a simple garden journal.\nI need to schedule a restore test.",
      interface: "web",
    },
  });
  await page.goto(base!);
  await expect(
    page.getByRole("heading", { name: "A little clarity." }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await request.get(`${base}/api/v1/workspace/overview`);
      return (await response.json()).counts.pending_jobs;
    })
    .toBe(0);
  await page.reload();
  const suggestion = page.locator("article").filter({
    has: page.getByRole("heading", { name: "A more thoughtful home lab" }),
  });
  await expect(suggestion).toBeVisible();
  await expect(suggestion.locator(".evidence")).toHaveCount(0);
  await suggestion.getByRole("button", { name: "Keep", exact: true }).click();
  // A note containing action-like prose must not manufacture commitments.
  expect(
    (await (await request.get(`${base}/api/v1/workspace/tasks`)).json()).tasks,
  ).toHaveLength(0);
  await request.post(`${base}/api/v1/workspace/tasks`, {
    data: { title: "schedule a restore test." },
  });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await expect(
    page.getByText("schedule a restore test.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Complete schedule a restore test." })
    .click();
  await page.getByLabel("Task status").selectOption("done");
  await expect(
    page.getByRole("button", { name: "Reopen schedule a restore test." }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Memory/ }).click();
  await page
    .getByRole("button", { name: /A more thoughtful home lab/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText(/Original source, not an instruction/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: /^Inbox/ }).click();
  await expect(
    page.getByRole("heading", { name: "Nothing to review" }),
  ).toBeVisible();
  await expect(page.getByText(/automatic interpretation is off/)).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "＋ Save a thought" }).click();
  await page.getByLabel("Title", { exact: true }).fill("A private note");
  await page
    .getByLabel("Your note")
    .fill("Remember the useful context, without a second task list.");
  await page.getByRole("button", { name: "Save thought", exact: true }).click();
  await expect(
    page.getByText("Saved. Processing will continue in the background."),
  ).toBeVisible();
});

test("workspace shows malformed capture status without replacing source text", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID();
  const receipt = await request.post(`${base}/api/v1/ingest/diff`, {
    data: {
      provider: "grok",
      external_session_id: id,
      sync_mode: "full_snapshot",
      messages: [
        {
          external_message_id: "a",
          role: "assistant",
          content: "r_123456abcdef",
        },
      ],
    },
  });
  expect((await receipt.json()).disposition).toBe("quarantined");
  await page.goto(base!);
  await expect(page.getByText(/captures need repair/)).toBeVisible();
  await page.getByRole("button", { name: "Review status" }).click();
  await expect(page.getByRole("dialog")).toContainText("missing user turns");
  await expect(page.getByRole("dialog")).not.toContainText("r_123456abcdef");
});

test("ChatGPT project context is separate, safely rendered, and manually overridable", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID();
  const capture = (minute: number, provider_project: unknown) =>
    request.post(`${base}/api/v1/ingest/diff`, {
      data: {
        provider: "chatgpt",
        external_session_id: id,
        captured_at: `2026-06-01T00:0${minute}:00Z`,
        provider_project,
        messages: [
          {
            external_message_id: "user",
            role: "user",
            content: "A private project conversation.",
          },
        ],
      },
    });
  const response = await capture(0, {
    id: "g-p-browser",
    name: "Browser project",
    instructions:
      '<img src=x onerror="window.projectInjection=true"> Do not execute this.',
    files: [{ id: "file-test", name: "Reference.pdf" }],
  });
  expect(response.ok()).toBe(true);
  const receipt = await response.json();
  const sourceId = `session:${receipt.session_id}`;
  await page.goto(base!);
  await page.getByRole("button", { name: /^Projects/ }).click();
  await page.getByRole("button", { name: /Browser project/ }).click();
  await page.getByText("ChatGPT project context", { exact: true }).click();
  await expect(page.getByText(/File references only/)).toBeVisible();
  await expect(page.getByText("Reference.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText(/window.projectInjection=true/)).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).projectInjection),
  ).toBeUndefined();
  const source = await (
    await request.get(
      `${base}/api/v1/workspace/sources/${encodeURIComponent(sourceId)}`,
    )
  ).json();
  expect(source.body).not.toContain("Do not execute");
  await request.patch(
    `${base}/api/v1/workspace/sources/${encodeURIComponent(sourceId)}`,
    {
      data: { expected_revision: source.revision, project_id: null },
    },
  );
  expect(
    (await capture(1, { id: "g-p-browser", name: "Renamed project" })).ok(),
  ).toBe(true);
  const after = await (
    await request.get(
      `${base}/api/v1/workspace/sources/${encodeURIComponent(sourceId)}`,
    )
  ).json();
  expect(after.project_id).toBeNull();
  expect(after.revision).toBe(source.revision);
});

test("private writing reviews exact copy, invalidates approval, and never publishes remotely", async ({
  page,
  request,
}) => {
  await page.goto(base!);
  await page.getByRole("button", { name: /^Writing/ }).click();
  await page.getByRole("button", { name: "＋ New draft" }).click();
  await page
    .getByLabel("Article title", { exact: true })
    .fill("A synthetic public essay");
  await page.getByLabel("Slug", { exact: true }).fill("synthetic-essay");
  await page
    .getByLabel("Private brief", { exact: true })
    .fill("PRIVATE_NOT_FOR_PUBLICATION");
  await page
    .getByLabel("Article Markdown", { exact: true })
    .fill(
      "Small tools can be useful.\n\nKeep their boundaries understandable.",
    );
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await page.getByRole("button", { name: /A synthetic public essay/ }).click();
  await page.getByRole("button", { name: "Review saved copy" }).click();
  await expect(page.getByRole("dialog")).not.toContainText(
    "PRIVATE_NOT_FOR_PUBLICATION",
  );
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Approve public copy" }).click();
  await expect(page.getByText(/Exact public copy approved/)).toBeVisible();
  const drafts = (
    await (await request.get(`${base}/api/v1/workspace/drafts`)).json()
  ).items;
  const draft = drafts.find((d: any) => d.slug === "synthetic-essay");
  expect(draft.status).toBe("approved");
  await page.getByRole("button", { name: /A synthetic public essay/ }).click();
  await page
    .getByLabel("Article Markdown", { exact: true })
    .fill("Changed copy requires a new review.");
  await page
    .getByRole("button", { name: "Save private draft", exact: true })
    .click();
  await expect(page.getByText(/Private draft saved/)).toBeVisible();
  const changed = await (
    await request.get(`${base}/api/v1/workspace/drafts/${draft.id}`)
  ).json();
  expect(changed.approval_hash).toBeNull();
  const blocked = await request.post(
    `${base}/api/v1/workspace/drafts/${draft.id}/export`,
    {
      data: {
        expected_version: changed.version,
        content_hash: changed.content_hash,
      },
    },
  );
  expect(blocked.status()).toBe(409);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
