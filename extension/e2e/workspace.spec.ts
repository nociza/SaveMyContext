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
