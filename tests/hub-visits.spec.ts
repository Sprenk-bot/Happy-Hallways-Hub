import { expect, test, type Page } from "@playwright/test";

const notifiedAt = "2026-11-12T01:00:00.000Z";
const arrivedAt = "2026-11-12T01:05:00.000Z";
const tripStartedAt = "2026-11-12T01:10:00.000Z";
const tripReturnedAt = "2026-11-12T01:15:00.000Z";
const leftHubAt = "2026-11-12T01:25:00.000Z";
const backAtClass = "2026-11-12T01:30:00.000Z";

async function installHubAudioSpy(page: Page) {
  await page.addInitScript(() => {
    (window as Window & { hubAudioStarts?: number }).hubAudioStarts = 0;
    class TestAudioContext {
      currentTime = 0;
      state = "running";
      destination = {};
      createOscillator() {
        const windowWithCounter = window as Window & {
          hubAudioStarts?: number;
        };
        return {
          type: "sine",
          frequency: { value: 0 },
          connect(destination: { connect: (node: object) => unknown }) {
            return destination;
          },
          start() {
            windowWithCounter.hubAudioStarts =
              (windowWithCounter.hubAudioStarts ?? 0) + 1;
          },
          stop() {},
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime() {},
            exponentialRampToValueAtTime() {},
          },
          connect(_destination: object) {
            return this;
          },
        };
      }
      resume() {
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: TestAudioContext,
    });
  });
}

async function seedVersionThreeAccount(page: Page) {
  await page.goto("/privacy");
  await page.evaluate((at) => {
    localStorage.clear();
    localStorage.setItem(
      "hallway.account.v2",
      JSON.stringify({
        version: 3,
        laptopPeerId: "hallway-fictional",
        roster: [
          {
            id: "maya",
            firstName: "Maya",
            lastName: "Chen",
            categoryId: "year-7",
          },
          {
            id: "sam",
            firstName: "Sam",
            lastName: "Patel",
            categoryId: "year-9",
          },
        ],
        destinations: [
          {
            id: "wellbeing",
            label: "Wellbeing",
            minutes: null,
            color: "teal",
            icon: "heart-handshake",
            limit: null,
            informHubAvailable: true,
          },
          {
            id: "check-in",
            label: "Check-in",
            minutes: null,
            color: "blue",
            icon: "user-round",
            limit: null,
          },
        ],
        classes: [
          {
            id: "p1",
            name: "Period 1",
            createdAt: at,
            members: [
              { studentId: "maya", lastPrefix: "C", status: "current" },
              { studentId: "sam", lastPrefix: "P", status: "current" },
            ],
          },
        ],
        activeClass: { id: "p1", changedAt: at },
        passes: [
          {
            id: "classroom-pass",
            classId: "p1",
            studentId: "maya",
            studentName: "Maya C.",
            destination: "Bathroom",
            minutes: 5,
            outAt: at,
            updatedAt: at,
          },
        ],
      }),
    );
  }, notifiedAt);
  await page.goto("/settings");
  await dismissWhatsChanged(page);
}

async function dismissWhatsChanged(page: Page) {
  const gotIt = page.getByRole("button", { name: "Got it" });
  try {
    await gotIt.waitFor({ state: "visible", timeout: 1_000 });
  } catch {
    return;
  }
  await gotIt.click();
}

test("upgrades version-three accounts without changing classroom passes", async ({
  page,
}) => {
  await seedVersionThreeAccount(page);
  const saved = await page.evaluate(async () => {
    const m = await import("/src/lib/account.svelte.ts");
    m.setPin("9753");
    return JSON.parse(localStorage.getItem("hallway.account.v2")!);
  });

  expect(saved.version).toBe(4);
  expect(saved.hubVisits).toEqual([]);
  expect(saved.passes).toHaveLength(1);
  expect(saved.passes[0]).toMatchObject({
    id: "classroom-pass",
    destination: "Bathroom",
    outAt: notifiedAt,
  });
});

test("class staff can notify, cancel or mark did not arrive without changing classroom passes", async ({
  page,
}) => {
  await seedVersionThreeAccount(page);
  await page.goto("/");
  await dismissWhatsChanged(page);

  await expect(page.getByRole("heading", { name: "Inform the Hub" })).toBeVisible();
  await page.getByLabel("Student to notify", { exact: true }).selectOption("maya");
  await expect(page.getByLabel("Hub destination", { exact: true }).locator("option")).toHaveText([
    "Choose a destination",
    "Wellbeing",
  ]);
  await page.getByLabel("Hub destination", { exact: true }).selectOption("wellbeing");
  await page.getByRole("button", { name: "Send notification" }).click();

  await expect(page.locator(".hub-notice")).toContainText(
    "Notification saved on this computer.",
  );
  await expect(page.getByText("On the way to the Hub")).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!),
  );
  expect(saved.hubVisits).toHaveLength(1);
  expect(saved.hubVisits[0]).toMatchObject({
    studentId: "maya",
    destinationId: "wellbeing",
    destinationLabel: "Wellbeing",
    classId: "p1",
    source: "classroom-notification",
    leftClassAt: expect.any(String),
  });
  expect(saved.passes).toHaveLength(1);
  expect(saved.passes[0].id).toBe("classroom-pass");

  await page.getByRole("button", { name: "Mark did not arrive", exact: true }).click();
  const didNotArriveDialog = page.locator('[aria-labelledby="confirm-title"]');
  await expect(
    didNotArriveDialog.getByRole("heading", { name: "Mark as did not arrive?" }),
  ).toBeVisible();
  await didNotArriveDialog
    .getByRole("button", { name: "Mark did not arrive", exact: true })
    .click();
  await expect(page.getByText("Did not arrive", { exact: true })).toBeVisible();
  const afterNoShow = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!),
  );
  expect(afterNoShow.hubVisits[0]).toMatchObject({
    cancellationReason: "did-not-arrive",
    cancelledAt: expect.any(String),
  });
  expect(afterNoShow.hubVisits[0].arrivedAtHubAt).toBeUndefined();
  expect(afterNoShow.hubVisits[0].leftHubAt).toBeUndefined();
  expect(afterNoShow.hubVisits[0].arrivedBackAtClassAt).toBeUndefined();
  expect(afterNoShow.passes).toEqual(saved.passes);

  await page.getByRole("button", { name: "Send notification" }).click();
  await expect(page.locator(".hub-visits li")).toHaveCount(2);
  await page.getByRole("button", { name: "Cancel notification", exact: true }).click();
  const cancellationDialog = page.locator('[aria-labelledby="confirm-title"]');
  await expect(
    cancellationDialog.getByRole("heading", { name: "Cancel this notification?" }),
  ).toBeVisible();
  await cancellationDialog
    .getByRole("button", { name: "Cancel notification", exact: true })
    .click();
  await expect(page.getByText("Notification withdrawn", { exact: true })).toBeVisible();
  const afterWithdrawal = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!),
  );
  expect(afterWithdrawal.hubVisits[1]).toMatchObject({
    cancellationReason: "withdrawn",
    cancelledAt: expect.any(String),
  });
  expect(afterWithdrawal.passes).toEqual(saved.passes);
});

test("an unresolved Hub movement remains visible for period review after the class changes", async ({
  page,
}) => {
  await seedVersionThreeAccount(page);
  await page.evaluate((at) => {
    const saved = JSON.parse(localStorage.getItem("hallway.account.v2")!);
    saved.passes = [];
    saved.classes.push({
      id: "p2",
      name: "Period 2",
      createdAt: at,
      members: [
        { studentId: "maya", lastPrefix: "C", status: "current" },
        { studentId: "sam", lastPrefix: "P", status: "current" },
      ],
    });
    localStorage.setItem("hallway.account.v2", JSON.stringify(saved));
  }, notifiedAt);
  await page.goto("/");
  await dismissWhatsChanged(page);

  await page.getByLabel("Student to notify", { exact: true }).selectOption("maya");
  await page.getByLabel("Hub destination", { exact: true }).selectOption("wellbeing");
  await page.getByRole("button", { name: "Send notification" }).click();
  await expect(page.getByText("On the way to the Hub", { exact: true })).toBeVisible();
  const originalVisit = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!).hubVisits[0],
  );

  await page.locator(".status-box").click();
  await page.getByRole("button", { name: /^Class on the kiosk:/ }).click();
  await page.getByRole("menuitemradio", { name: "Period 2" }).click();
  const switchWarning = page.locator('[aria-labelledby="confirm-title"]');
  await expect(switchWarning).toContainText(
    "1 unresolved Hub movement will remain open for review.",
  );
  await expect(switchWarning).toContainText("No event times will be changed.");
  await switchWarning.getByRole("button", { name: "Switch class" }).click();

  const movement = page.locator(".hub-visits li").filter({ hasText: "Maya Chen" });
  await expect(movement).toContainText("Period transition review");
  await expect(movement).toContainText("On the way to the Hub");
  await expect(movement).toContainText("Period 1");
  const afterTransition = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!).hubVisits[0],
  );
  expect(afterTransition).toMatchObject({
    id: originalVisit.id,
    classId: originalVisit.classId,
    className: originalVisit.className,
    leftClassAt: originalVisit.leftClassAt,
  });
  expect(afterTransition.arrivedAtHubAt).toBeUndefined();
  expect(afterTransition.arrivedBackAtClassAt).toBeUndefined();
});

test("staff confirm arrival, Hub departure and class return as separate events", async ({
  page,
}) => {
  await seedVersionThreeAccount(page);
  await page.goto("/");
  await dismissWhatsChanged(page);

  await page.getByLabel("Student to notify", { exact: true }).selectOption("maya");
  await page.getByLabel("Hub destination", { exact: true }).selectOption("wellbeing");
  await page.getByRole("button", { name: "Send notification" }).click();
  await expect(page.getByText("On the way to the Hub", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Confirm arrived at Hub" }).click();
  await expect(page.getByText("At the Hub", { exact: true })).toBeVisible();
  await expect(page.locator(".hub-notice")).toContainText(
    "Hub arrival saved on this computer.",
  );
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!),
  );
  expect(saved.hubVisits[0].arrivedAtHubAt).toMatch(/T/);
  expect(saved.hubVisits[0].leftHubAt).toBeUndefined();
  expect(saved.hubVisits[0].arrivedBackAtClassAt).toBeUndefined();

  await page.getByRole("button", { name: "Confirm left Hub" }).click();
  const departureDialog = page.locator('[aria-labelledby="confirm-title"]');
  await expect(
    departureDialog.getByRole("heading", {
      name: "Confirm the student has left the Hub?",
    }),
  ).toBeVisible();
  await departureDialog
    .getByRole("button", { name: "Confirm left Hub", exact: true })
    .click();
  await expect(
    page.getByText("Left the Hub; return to class not confirmed", {
      exact: true,
    }),
  ).toBeVisible();

  let afterDeparture = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!),
  );
  expect(afterDeparture.hubVisits[0].leftHubAt).toMatch(/T/);
  expect(afterDeparture.hubVisits[0].arrivedBackAtClassAt).toBeUndefined();

  await page.getByRole("button", { name: "Confirm back in class" }).click();
  await expect(page.locator(".hub-notice")).toContainText(
    "Return confirmation saved on this computer.",
  );
  afterDeparture = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!),
  );
  expect(afterDeparture.hubVisits[0].arrivedBackAtClassAt).toMatch(/T/);
});

test("browser-only mode keeps private concern routing unavailable", async ({
  page,
}) => {
  await seedVersionThreeAccount(page);
  await page.goto("/");
  await dismissWhatsChanged(page);

  await expect(page.getByRole("radio", { name: "No Concerns" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Concern", exact: true })).toBeDisabled();
  await expect(
    page.getByText("Private concern notes require the Hub Host."),
  ).toBeVisible();

  await page.getByRole("link", { name: "Mail Centre" }).click();
  await expect(
    page.getByText("Private Hub messages are available when connected to the Hub Host."),
  ).toBeVisible();
});

test("Hub Host mode saves only the warning flag in shared state and delivers the private note to TIC", async ({
  page,
}) => {
  const at = notifiedAt;
  const ticId = "fictional-staff-tic";
  const eaId = "fictional-staff-ea";
  const studentId = "maya";
  const note = "Fictional private concern for an authorised recipient.";
  let state: {
    revision: number;
    savedAt: string;
    visits: {
      id: string;
      studentName: string;
      destinationLabel: string;
      status: "on-the-way" | "at-hub";
      pinRequired: boolean;
    }[];
  } = {
    revision: 1,
    snapshot: {
      version: 4,
      roster: [
        {
          id: studentId,
          firstName: "Maya",
          lastName: "Chen",
          categoryId: "year-7",
        },
      ],
      studentCategories: [{ id: "year-7", name: "Year 7", color: "blue" }],
      destinations: [
        {
          id: "wellbeing",
          label: "Wellbeing",
          minutes: null,
          color: "teal",
          icon: "heart-handshake",
          limit: null,
          informHubAvailable: true,
        },
      ],
      classes: [
        {
          id: "p1",
          name: "Period 1",
          createdAt: at,
          members: [{ studentId, lastPrefix: "C", status: "current" }],
        },
      ],
      activeClass: { id: "p1", changedAt: at },
      passes: [],
      hubVisits: [],
    },
  };
  let submittedConcern: Record<string, unknown> | null = null;
  let savedMessage: Record<string, unknown> | null = null;

  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: html.replace(
        "<head>",
        '<head><meta name="happy-hallways-hub-host" content="true">',
      ),
    });
  });

  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "fictional-session-ea",
        staffId: eaId,
        displayName: "EA Example",
        role: "ea",
        authMethod: "named-profile-device-enrolment-fallback",
        identityVerified: false,
        mfaVerified: false,
        expiresAt: "2026-11-13T00:00:00.000Z",
      }),
    }),
  );
  await page.route("**/api/v1/state", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...state, savedAt: at, checksum: "fictional-checksum" }),
      });
      return;
    }
    const request = route.request().postDataJSON() as {
      snapshot: typeof state.snapshot;
    };
    state = {
      revision: state.revision + 1,
      snapshot: {
        ...request.snapshot,
        hubVisits: request.snapshot.hubVisits.map((visit) => ({
          ...visit,
          notifiedBy: {
            staffId: eaId,
            displayName: "EA Example",
            role: "ea",
          },
          ...(visit.arrivedAtHubAt
            ? {
                arrivedBy: {
                  staffId: eaId,
                  displayName: "EA Example",
                  role: "ea",
                },
              }
            : {}),
        })),
      },
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...state, savedAt: at, checksum: "fictional-checksum" }),
    });
  });
  await page.route("**/api/v1/preferences", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ favouriteStudentIds: [], updatedAt: null }),
    }),
  );
  await page.route("**/api/v1/mail/recipients", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recipients: [
          { staffId: ticId, displayName: "TIC Example", role: "tic" },
          { staffId: eaId, displayName: "EA Example", role: "ea" },
        ],
      }),
    }),
  );
  await page.route("**/api/v1/concerns/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        availableScopes: ["tic", "all-staff", "selected"],
        defaultScope: "tic",
        updatedAt: at,
      }),
    }),
  );
  await page.route("**/api/v1/concerns", async (route) => {
    submittedConcern = route.request().postDataJSON() as Record<string, unknown>;
    const visit = state.snapshot.hubVisits[0];
    savedMessage = {
      id: "fictional-message-1",
      visitId: visit.id,
      studentId: visit.studentId,
      studentName: visit.studentName,
      destinationLabel: visit.destinationLabel,
      senderStaffId: eaId,
      senderDisplayName: "EA Example",
      scope: "tic",
      note,
      submittedAt: at,
      recipients: [{ staffId: ticId, displayName: "TIC Example", role: "tic" }],
      isSender: true,
      isRecipient: false,
      isTicOversight: false,
      readAt: null,
    };
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(savedMessage),
    });
  });
  await page.route("**/api/v1/mail", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: savedMessage ? [savedMessage] : [],
        unreadCount: 0,
      }),
    }),
  );

  await page.addLocatorHandler(
    page.locator('[aria-labelledby="whats-changed-title"]'),
    async () => {
      await page.keyboard.press("Escape");
    },
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Inform the Hub" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Concern", exact: true })).toBeEnabled();
  await page.getByLabel("Student to notify", { exact: true }).selectOption(studentId);
  await page.getByLabel("Hub destination", { exact: true }).selectOption("wellbeing");
  await page.getByRole("radio", { name: "Concern", exact: true }).check();
  await expect(page.getByRole("radio", { name: /TIC only \(default\)/ })).toBeChecked();
  await page.getByLabel("Brief explanation").fill(note);
  await page.getByRole("button", { name: "Send notification" }).click();

  await expect(page.locator(".hub-notice")).toContainText(
    "The movement and private concern note were saved to the Hub Host.",
  );
  expect(submittedConcern).toMatchObject({
    note,
    scope: "tic",
    recipientIds: [],
  });
  expect(state.snapshot.hubVisits[0]).toMatchObject({
    studentId,
    hasConcern: true,
    notifiedBy: { staffId: eaId },
  });
  expect(JSON.stringify(state.snapshot)).not.toContain(note);
  await expect(
    page.getByText("A concern is recorded; private details are in the Mail Centre."),
  ).toBeAttached();

  await page.getByRole("link", { name: "Mail Centre" }).click();
  await expect(page.getByText(note)).toBeVisible();
  await expect(page.getByText("Maya Chen · Wellbeing")).toBeVisible();

  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Confirm arrived at Hub" }).click();
  await expect(page.locator(".hub-notice")).toContainText(
    "Hub arrival saved to the Hub Host.",
  );
  expect(state.snapshot.hubVisits[0]).toMatchObject({
    arrivedAtHubAt: expect.any(String),
    arrivedBy: { staffId: eaId },
  });
  expect(state.snapshot.hubVisits[0].leftHubAt).toBeUndefined();
});

test("favourites stay in this browser, group first, and filter by name and year group", async ({
  page,
}) => {
  await seedVersionThreeAccount(page);
  await page.goto("/");
  await dismissWhatsChanged(page);

  await page.getByLabel("Search Hub students", { exact: true }).fill("Maya");
  await page.getByLabel("Filter Hub students by year group", { exact: true }).selectOption("year-7");
  await page.getByLabel("Student to notify", { exact: true }).selectOption("maya");
  await page.getByRole("button", { name: "Add Maya Chen to favourites" }).click();
  await expect(page.locator("#hub-student optgroup[label='Favourites'] option")).toHaveText(
    "Maya Chen",
  );
  await expect(page.getByLabel("Search Hub students", { exact: true })).toHaveValue("Maya");

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("happy-hallways.hub-favourites.v1")!),
  );
  expect(saved).toEqual(["maya"]);

  await page.reload();
  await dismissWhatsChanged(page);
  await expect(page.locator("#hub-student optgroup[label='Favourites'] option")).toHaveText(
    "Maya Chen",
  );
  await page.getByLabel("Search Hub students", { exact: true }).fill("");
  await page.getByLabel("Filter Hub students by year group", { exact: true }).selectOption("year-9");
  await expect(page.getByLabel("Student to notify", { exact: true }).locator("option")).toContainText([
    "Choose a student",
    "Sam Patel",
  ]);
});

test("destination opt-in is off until staff enable it", async ({ page }) => {
  await page.goto("/destinations");
  await page.getByRole("button", { name: /New destination|Add/ }).first().click();
  await page.getByLabel("Name").fill("Wellbeing");
  const informOption = page.getByLabel("Available in Inform the Hub");
  await expect(informOption).not.toBeChecked();
  await informOption.check();
  await page
    .getByLabel("Hub kiosk confirmation message (optional)")
    .fill("Your Hub check-in is saved. Take a moment to settle in.");
  await page.getByLabel("Hub kiosk arrival chime").selectOption("bright");
  await page.getByText("Arrival prompts (0)").click();
  await page.getByRole("button", { name: "Add arrival prompt" }).click();
  await page.getByLabel("Question").fill("How are you feeling?");
  await page.getByLabel("Response required").check();
  await page.getByRole("button", { name: "Save" }).click();

  const destinations = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!).destinations,
  );
  expect(destinations.find((destination: { label: string }) => destination.label === "Wellbeing"))
    .toMatchObject({
      informHubAvailable: true,
      kioskConfirmation:
        "Your Hub check-in is saved. Take a moment to settle in.",
      hubArrivalChime: "bright",
      hubPromptVersion: 1,
      hubArrivalPrompts: [
        {
          question: "How are you feeling?",
          responseType: "written",
          required: true,
        },
      ],
    });

  await page.getByRole("button", { name: /^Wellbeing/ }).click();
  await expect(page.getByLabel("Available in Inform the Hub")).toBeChecked();
  await page.getByText("Arrival prompts (1)").click();
  await page.getByLabel("Question").fill("How are you feeling today?");
  await page.getByLabel("Available in Inform the Hub").uncheck();
  await expect(
    page.getByLabel("Hub kiosk confirmation message (optional)"),
  ).toHaveValue("Your Hub check-in is saved. Take a moment to settle in.");
  await page.getByLabel("Hub kiosk confirmation message (optional)").fill("");
  await page.getByLabel("Hub kiosk arrival chime").selectOption("soft");
  await page.getByRole("button", { name: "Save" }).click();
  const updatedDestinations = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!).destinations,
  );
  expect(
    updatedDestinations.find(
      (destination: { label: string }) => destination.label === "Wellbeing",
    ),
  ).toMatchObject({
    hubPromptVersion: 2,
    hubArrivalPrompts: [
      {
        question: "How are you feeling today?",
        required: true,
      },
    ],
  });
  expect(
    updatedDestinations.find(
      (destination: { label: string }) => destination.label === "Wellbeing",
    ),
  ).not.toHaveProperty("informHubAvailable");
  expect(
    updatedDestinations.find(
      (destination: { label: string }) => destination.label === "Wellbeing",
    ),
  ).not.toHaveProperty("kioskConfirmation");
  expect(
    updatedDestinations.find(
      (destination: { label: string }) => destination.label === "Wellbeing",
    ),
  ).not.toHaveProperty("hubArrivalChime");
});

test("class staff can confirm a student back after the Hub visit", async ({
  page,
}) => {
  await installHubAudioSpy(page);
  await seedVersionThreeAccount(page);
  await page.evaluate(async () => {
    const m = await import("/src/lib/account.svelte.ts");
    const visitId = m.notifyHubVisit({
      studentId: "maya",
      destinationId: "wellbeing",
      classId: "p1",
    }, "2026-11-12T01:00:00.000Z");
    m.recordHubArrival(visitId, "2026-11-12T01:05:00.000Z");
    m.leaveHub(visitId, "2026-11-12T01:10:00.000Z");
  });
  await page.goto("/");
  await dismissWhatsChanged(page);

  await page.getByRole("button", { name: "Confirm back in class" }).click();
  await expect(page.locator(".hub-notice")).toContainText(
    "Return confirmation saved on this computer.",
  );
  expect(
    await page.evaluate(
      () => (window as Window & { hubAudioStarts?: number }).hubAudioStarts ?? 0,
    ),
  ).toBeGreaterThan(0);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hallway.account.v2")!),
  );
  expect(saved.hubVisits[0].arrivedBackAtClassAt).toMatch(/T/);
});

test("keeps Hub movement timestamps separate and nests one active Temporary Trip", async ({
  page,
}) => {
  await seedVersionThreeAccount(page);
  const result = await page.evaluate(
    async (times) => {
      const m = await import("/src/lib/account.svelte.ts");
      const safeError = (action: () => void) => {
        try {
          action();
          return "";
        } catch (error) {
          return (error as Error).message;
        }
      };
      const visitId = m.notifyHubVisit(
        {
          studentId: "maya",
          destinationId: "wellbeing",
          classId: "p1",
          periodName: "Period 1",
        },
        times.notifiedAt,
      );
      const visit = m.account.hubVisits.find((each) => each.id === visitId)!;
      const statuses = [m.hubVisitStatus(visit)];
      const duplicateVisitError = safeError(() =>
        m.startHubVisit(
          { studentId: "maya", destinationId: "wellbeing" },
          times.arrivedAt,
        ),
      );
      const disabledDestinationError = safeError(() =>
        m.notifyHubVisit(
          {
            studentId: "sam",
            destinationId: "check-in",
            classId: "p1",
          },
          times.notifiedAt,
        ),
      );

      m.recordHubArrival(visitId, times.arrivedAt);
      statuses.push(m.hubVisitStatus(visit));
      const tripId = m.startTemporaryTrip(
        visitId,
        "Bathroom",
        times.tripStartedAt,
      );
      statuses.push(m.hubVisitStatus(visit));
      const duplicateTripError = safeError(() =>
        m.startTemporaryTrip(visitId, "Quiet Room", times.tripStartedAt),
      );
      const leaveDuringTripError = safeError(() =>
        m.leaveHub(visitId, times.leftHubAt),
      );
      m.returnFromTemporaryTrip(visitId, tripId, times.tripReturnedAt);
      statuses.push(m.hubVisitStatus(visit));
      m.updateStudentCategory("year-7", {
        name: "Year 7 renamed",
        color: "blue",
      });
      m.leaveHub(visitId, times.leftHubAt);
      statuses.push(m.hubVisitStatus(visit));
      m.confirmArrivedBackAtClass(visitId, times.backAtClass);
      statuses.push(m.hubVisitStatus(visit));

      const directId = m.startHubVisit(
        { studentId: "sam", destinationId: "check-in" },
        times.arrivedAt,
      );
      const direct = m.account.hubVisits.find((each) => each.id === directId)!;
      return JSON.parse(
        JSON.stringify({
          visit,
          statuses,
          duplicateVisitError,
          disabledDestinationError,
          duplicateTripError,
          leaveDuringTripError,
          direct,
          passes: m.account.passes,
        }),
      );
    },
    {
      notifiedAt,
      arrivedAt,
      tripStartedAt,
      tripReturnedAt,
      leftHubAt,
      backAtClass,
    },
  );

  expect(result.statuses).toEqual([
    "on-the-way",
    "at-hub",
    "on-temporary-trip",
    "at-hub",
    "left-hub-awaiting-class",
    "returned-to-class",
  ]);
  expect(result.duplicateVisitError).toContain("already has an active");
  expect(result.disabledDestinationError).toContain("not enabled");
  expect(result.duplicateTripError).toContain("already has an active");
  expect(result.leaveDuringTripError).toContain("Temporary Trip must return");
  expect(result.visit).toMatchObject({
    source: "classroom-notification",
    leftClassAt: notifiedAt,
    arrivedAtHubAt: arrivedAt,
    leftHubAt,
    arrivedBackAtClassAt: backAtClass,
    studentCategory: { id: "year-7", name: "Year 7", color: "blue" },
    temporaryTrips: [
      {
        destinationLabel: "Bathroom",
        startedAt: tripStartedAt,
        returnedAt: tripReturnedAt,
      },
    ],
  });
  expect(result.direct).toMatchObject({
    source: "direct-kiosk-arrival",
    arrivedAtHubAt: arrivedAt,
  });
  expect(result.direct.leftClassAt).toBeUndefined();
  expect(result.passes).toHaveLength(1);
  expect(result.passes[0]).toMatchObject({
    id: "classroom-pass",
    destination: "Bathroom",
    outAt: notifiedAt,
  });
});

test("the separate Hub kiosk redeems its activation link and waits for Host acknowledgements", async ({
  page,
}) => {
  await installHubAudioSpy(page);
  type MockStudent = {
    id: string;
    studentName: string;
    status:
      | "in-class"
      | "on-the-way"
      | "at-hub"
      | "on-temporary-trip"
      | "left-hub-awaiting-class"
      | "needs-staff";
    pinRequired: boolean;
    visitId?: string;
    destinationLabel?: string;
    temporaryTripLabel?: string;
    promptVersion?: number;
    arrivalPrompts?: {
      id: string;
      question: string;
      responseType: "written" | "rating";
      required: boolean;
      scaleMax?: 5 | 10;
      ratingStyle?: "numbers" | "stars";
    }[];
    departurePrompts?: {
      id: string;
      question: string;
      responseType: "written" | "rating";
      required: boolean;
    }[];
  };
  let state: {
    revision: number;
    savedAt: string;
    students: MockStudent[];
    destinations: {
      id: string;
      label: string;
      promptVersion: number;
      arrivalPrompts: MockStudent["arrivalPrompts"];
    }[];
    temporaryDestinations: {
      id: string;
      label: string;
      promptVersion: number;
      arrivalPrompts: MockStudent["arrivalPrompts"];
    }[];
    soundSettings: { muted: boolean; volume: number; commonChime: string };
    promptOverrides: {
      studentId: string;
      destinationId: string;
      stage: "arrival" | "departure";
    }[];
  } = {
    revision: 1,
    savedAt: notifiedAt,
    students: [
      {
        id: "fictional-kiosk-student",
        studentName: "Avery E.",
        status: "on-the-way",
        pinRequired: true,
        visitId: "fictional-kiosk-visit",
        destinationLabel: "Private destination",
        promptVersion: 1,
        arrivalPrompts: [
          {
            id: "fictional-arrival-rating",
            question: "How are you feeling?",
            responseType: "rating",
            required: true,
            scaleMax: 5,
          },
        ],
        departurePrompts: [
          {
            id: "fictional-departure-writing",
            question: "What would help next?",
            responseType: "written",
            required: true,
          },
        ],
      },
      {
        id: "fictional-direct-student",
        studentName: "Riley S.",
        status: "in-class",
        pinRequired: true,
        promptVersion: 1,
      },
    ],
    destinations: [
      {
        id: "wellbeing",
        label: "Wellbeing",
        promptVersion: 1,
        arrivalPrompts: [],
      },
      {
        id: "private-destination",
        label: "Private destination",
        promptVersion: 1,
        arrivalPrompts: [
          {
            id: "fictional-direct-rating",
            question: "Are you ready to sign in?",
            responseType: "rating",
            required: true,
            scaleMax: 5,
          },
        ],
      },
    ],
    temporaryDestinations: [
      {
        id: "bathroom",
        label: "Bathroom",
        promptVersion: 1,
        arrivalPrompts: [],
      },
    ],
    soundSettings: { muted: false, volume: 70, commonChime: "soft" },
    promptOverrides: [
      {
        studentId: "fictional-direct-student",
        destinationId: "private-destination",
        stage: "arrival",
      },
    ],
  };
  const actions: {
    action: string;
    studentId?: string;
    visitId?: string;
    destinationId?: string;
    pin?: string;
  }[] = [];
  let rejectNextArrival = true;

  await page.route("**/api/v1/kiosk/activate", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      token: "fictional-one-use-activation",
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      headers: {
        "Set-Cookie":
          "hh_hub_kiosk=fictional-kiosk-session; HttpOnly; SameSite=Strict; Path=/api/v1/kiosk",
      },
      body: JSON.stringify({ expiresAt: "2026-11-13T01:00:00.000Z" }),
    });
  });
  await page.route("**/api/v1/kiosk/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state),
    });
  });
  await page.route("**/api/v1/kiosk/movements", async (route) => {
    const body = route.request().postDataJSON();
    actions.push(body);
    if (body.action === "arrive" && rejectNextArrival) {
      rejectNextArrival = false;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "movement_not_allowed" }),
      });
      return;
    }
    if (body.action === "direct-arrive") {
      const student = state.students.find(
        (each) => each.id === body.studentId,
      )!;
      student.status = "at-hub";
      student.visitId = "fictional-direct-visit";
      student.destinationLabel =
        state.destinations.find(
          (destination) => destination.id === body.destinationId,
        )?.label ?? "Hub destination";
    } else {
      const student = state.students.find(
        (each) => each.visitId === body.visitId,
      )!;
      if (body.action === "arrive") student.status = "at-hub";
      if (body.action === "temporary-start") {
        student.status = "on-temporary-trip";
        student.temporaryTripLabel = "Bathroom";
      }
      if (body.action === "temporary-return") {
        student.status = "at-hub";
        delete student.temporaryTripLabel;
      }
      if (body.action === "leave") {
        student.status = "left-hub-awaiting-class";
      }
    }
    state = {
      revision: state.revision + 1,
      savedAt: new Date().toISOString(),
      students: state.students,
      destinations: state.destinations,
      temporaryDestinations: state.temporaryDestinations,
      soundSettings: state.soundSettings,
      promptOverrides: state.promptOverrides,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        revision: state.revision,
        savedAt: state.savedAt,
        chime:
          body.action === "arrive" || body.action === "direct-arrive"
            ? "soft"
            : body.action === "temporary-return"
              ? state.soundSettings.commonChime
              : "none",
        ...(body.action === "direct-arrive"
          ? {
              confirmationMessage:
                "Your arrival at the selected destination has been saved.",
            }
          : body.action === "arrive"
            ? {
                confirmationMessage:
                  "Your arrival was saved by the Hub Host.",
              }
            : {}),
      }),
    });
  });

  await page.goto("/hub-kiosk#activate=fictional-one-use-activation");
  await expect(page.getByRole("heading", { name: "Tap your name" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Avery E\./ })).toBeVisible();
  await expect(page).not.toHaveURL(/fictional-one-use-activation/);

  await page.getByRole("button", { name: /Avery E\./ }).click();
  await page.getByLabel("Student PIN for Avery E.").fill("4567");
  await page.getByRole("button", { name: "Sign in at the Hub" }).click();
  await expect(
    page.getByRole("group", { name: "How are you feeling?", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "4 of 5" }).click();
  await page.getByLabel("Student PIN for Avery E.").fill("4567");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".message.error")).toContainText(
    "action was not accepted",
  );
  expect(
    await page.evaluate(
      () => (window as Window & { hubAudioStarts?: number }).hubAudioStarts ?? 0,
    ),
  ).toBe(0);
  await page.getByLabel("Student PIN for Avery E.").fill("4567");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".message.success")).toContainText(
    "arrival was saved by the Hub Host",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { hubAudioStarts?: number }).hubAudioStarts ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await page.getByLabel("Student PIN for Avery E.").fill("4567");
  await page.getByRole("button", { name: "Bathroom" }).click();
  await expect(page.locator(".message.success")).toContainText(
    "Temporary Trip was saved by the Hub Host",
  );
  await page.getByLabel("Student PIN for Avery E.").fill("4567");
  await page.getByRole("button", { name: "I am back at the Hub" }).click();
  await expect(page.locator(".message.success")).toContainText(
    "return to the Hub was saved by the Hub Host",
  );
  await expect(page.getByRole("button", { name: "Leave the Hub" })).toBeVisible();
  await page.getByLabel("Student PIN for Avery E.").fill("4567");
  await page.getByRole("button", { name: "Leave the Hub" }).click();
  await page.getByLabel("What would help next?").fill("Return to class calmly.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".message.success")).toContainText(
    "Leaving the Hub was saved",
  );
  await expect(
    page.getByRole("button", { name: /Avery E\. Left the Hub/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Riley S\./ }).click();
  await page.getByLabel("Student PIN for Riley S.").fill("7890");
  await page.getByRole("button", { name: "Private destination" }).click();
  await page.getByRole("button", { name: "Sign in at the Hub" }).click();
  await expect(page.getByText("Optional", { exact: true })).toBeVisible();
  await page.getByLabel("Student PIN for Riley S.").fill("7890");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".message.success")).toHaveText(
    "Your arrival at the selected destination has been saved.",
  );
  expect(actions).toEqual([
    {
      action: "arrive",
      visitId: "fictional-kiosk-visit",
      pin: "4567",
      promptVersion: 1,
      promptAnswers: { "fictional-arrival-rating": 4 },
    },
    {
      action: "arrive",
      visitId: "fictional-kiosk-visit",
      pin: "4567",
      promptVersion: 1,
      promptAnswers: { "fictional-arrival-rating": 4 },
    },
    {
      action: "temporary-start",
      visitId: "fictional-kiosk-visit",
      destinationId: "bathroom",
      pin: "4567",
    },
    {
      action: "temporary-return",
      visitId: "fictional-kiosk-visit",
      pin: "4567",
    },
    {
      action: "leave",
      visitId: "fictional-kiosk-visit",
      pin: "4567",
      promptVersion: 1,
      promptAnswers: {
        "fictional-departure-writing": "Return to class calmly.",
      },
    },
    {
      action: "direct-arrive",
      studentId: "fictional-direct-student",
      destinationId: "private-destination",
      pin: "7890",
      promptVersion: 1,
      promptAnswers: {},
    },
  ]);
});

test("staff can issue a reasoned prompt override without sending its reason to the kiosk", async ({
  page,
}) => {
  const at = notifiedAt;
  const snapshot = {
    roster: [
      {
        id: "fictional-student",
        firstName: "Avery",
        lastName: "Example",
      },
    ],
    classes: [
      {
        id: "fictional-class",
        members: [
          {
            studentId: "fictional-student",
            status: "current",
          },
        ],
      },
    ],
    destinations: [
      {
        id: "fictional-destination",
        label: "Wellbeing",
        kioskAvailable: true,
        hubPromptVersion: 1,
        hubArrivalPrompts: [
          {
            id: "fictional-prompt",
            question: "How are you feeling?",
            responseType: "written",
            required: true,
          },
        ],
      },
    ],
    hubVisits: [],
  };
  let overrideRequest: Record<string, unknown> | null = null;
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: html.replace(
        "<head>",
        '<head><meta name="happy-hallways-hub-host" content="true">',
      ),
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/health") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          storage: "sqlite",
          application: "served_from_host",
          network: { mode: "loopback_only", schoolLanTest: "not_verified" },
          revision: 1,
          lastSavedAt: at,
        }),
      });
      return;
    }
    if (url.pathname === "/api/v1/auth/options") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          preferred: { enabled: false },
          fallback: { enabled: true },
        }),
      });
      return;
    }
    if (url.pathname === "/api/v1/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "fictional-staff-session",
          staffId: "fictional-staff",
          displayName: "EA Example",
          role: "ea",
          authMethod: "named-profile-device-enrolment-fallback",
          identityVerified: false,
          mfaVerified: false,
          expiresAt: "2026-11-13T00:00:00.000Z",
        }),
      });
      return;
    }
    if (url.pathname === "/api/v1/state" && route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: 1,
          savedAt: at,
          checksum: "fictional-checksum",
          snapshot,
        }),
      });
      return;
    }
    if (url.pathname === "/api/v1/hub/prompt-overrides") {
      overrideRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          revision: 2,
          expiresAt: "2026-11-12T01:10:00.000Z",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await page.goto("/hub-admin");
  await expect(
    page.getByRole("heading", {
      name: "Temporarily waive a required Hub question",
    }),
  ).toBeVisible();
  await page.getByLabel("Student", { exact: true }).selectOption("fictional-student");
  await page.getByLabel("Destination", { exact: true }).selectOption("fictional-destination");
  const reason = "Student cannot answer right now.";
  await page.getByLabel("Reason (3–300 characters)").fill(reason);
  await page.getByRole("button", { name: "Issue one-use override" }).click();
  await expect(page.getByRole("status")).toContainText("One-use override saved");
  expect(overrideRequest).toEqual({
    studentId: "fictional-student",
    destinationId: "fictional-destination",
    stage: "arrival",
    reason,
  });
});

test("Hub Details and Hub History show the saved timeline without replacing pass History", async ({ page }) => {
  const snapshot = {
    version: 4,
    roster: [{ id: "fictional-student", firstName: "Avery", lastName: "Example", categoryId: "year-7" }],
    studentCategories: [{ id: "year-7", name: "Year 7", color: "blue" }],
    classes: [{ id: "fictional-class", name: "Support Group", members: [] }],
    destinations: [],
    hubVisits: [{
      id: "fictional-visit",
      studentId: "fictional-student",
      studentName: "Avery Example",
      studentCategory: { id: "year-7", name: "Year 7", color: "blue" },
      destinationLabel: "Quiet Room",
      classId: "fictional-class",
      className: "Support Group",
      periodName: "Morning check-in",
      source: "classroom-notification",
      notifiedBy: { staffId: "fictional-ea", displayName: "EA Example", role: "ea" },
      leftClassAt: notifiedAt,
      hasConcern: true,
      arrivedAtHubAt: arrivedAt,
      temporaryTrips: [{
        id: "fictional-trip",
        destinationLabel: "Library",
        startedAt: tripStartedAt,
        startedBy: { type: "student-kiosk" },
        returnedAt: tripReturnedAt,
        returnedBy: { type: "student-kiosk" },
      }],
      promptResponses: [{
        promptId: "fictional-prompt",
        promptVersion: 1,
        destinationId: "quiet-room",
        stage: "arrival",
        question: "How are you feeling?",
        responseType: "written",
        required: true,
        answer: "I feel settled.",
        answeredAt: "2026-11-12T01:06:00.000Z",
      }],
    }],
  };
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: html.replace("<head>", '<head><meta name="happy-hallways-hub-host" content="true">'),
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/session") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        sessionId: "fictional-session", staffId: "fictional-ea", displayName: "EA Example", role: "ea",
        authMethod: "named-profile-device-enrolment-fallback", identityVerified: false, mfaVerified: false,
        expiresAt: "2026-11-13T00:00:00.000Z",
      }) });
    }
    if (url.pathname === "/api/v1/state") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 1, savedAt: notifiedAt, checksum: "fictional-checksum", snapshot }) });
    }
    if (url.pathname === "/api/v1/mail") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [], unreadCount: 0 }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.goto("/details");
  await page.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});
  await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
  await expect(page.locator("tbody").getByText("At the Hub")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Hub History" })).toBeVisible();
  await page.goto("/hub-history");
  await expect(page.getByRole("heading", { name: "Hub History" })).toBeVisible();
  await expect(page.getByText("Started temporary trip: Library")).toBeVisible();
  await expect(page.getByText("How are you feeling?: I feel settled.")).toBeVisible();
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "Every pass, in every class" })).toBeVisible();
});
