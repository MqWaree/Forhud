import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";

const dbPath = resolve(process.cwd(), "work", "outreach-integration.db");
rmSync(dbPath, { force: true });
execFileSync(process.execPath, [
  resolve(process.cwd(), "apps/server/scripts/migrate-local.mjs"),
  dbPath,
]);
process.env.DATABASE_URL = `file:${dbPath.replaceAll("\\", "/")}`;

let app: any;
let prisma: any;
let admin: ReturnType<typeof request.agent>;
let researcher: ReturnType<typeof request.agent>;
let leadId = "";

beforeAll(async () => {
  const module = await import("./app.js");
  app = module.default;
  prisma = module.prisma;
  await module.scannerReady;
  admin = request.agent(app);
  researcher = request.agent(app);
  expect(
    (
      await admin.post("/api/auth/setup").send({
        username: "outreach_admin",
        password: "outreach admin password 12345",
      })
    ).status,
  ).toBe(201);
  await admin.post("/api/admin/users").send({
    username: "outreach_researcher",
    password: "outreach research password 123",
    role: "RESEARCHER",
    requirePasswordChange: false,
  });
  expect(
    (
      await researcher.post("/api/auth/login").send({
        username: "outreach_researcher",
        password: "outreach research password 123",
      })
    ).status,
  ).toBe(200);
  const lead = await admin
    .post("/api/leads")
    .send({ url: "https://15.0.0.9/contact" });
  expect(lead.status).toBe(201);
  leadId = lead.body.id;
});
afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(dbPath, { force: true });
});

describe("outreach templates and the sent log", () => {
  it("seeds default templates once and lets managers edit them", async () => {
    const first = await admin.get("/api/outreach/templates");
    expect(first.status).toBe(200);
    expect(
      first.body.map((template: { name: string }) => template.name),
    ).toEqual(["Partnership intro", "Short Discord message"]);
    expect(first.body[0].body).toContain("{rust_products}");
    const second = await admin.get("/api/outreach/templates");
    expect(second.body).toHaveLength(2);

    const created = await admin
      .post("/api/outreach/templates")
      .send({ name: "Hosting pitch", body: "Hi {company}, {sender} here." });
    expect(created.status).toBe(201);
    const updated = await admin
      .patch(`/api/outreach/templates/${created.body.id}`)
      .send({ body: "Hello {company}!" });
    expect(updated.body.body).toBe("Hello {company}!");
    expect((await admin.get("/api/outreach/templates")).body).toHaveLength(3);
    expect(
      (await admin.delete(`/api/outreach/templates/${created.body.id}`)).status,
    ).toBe(204);
  });

  it("lets researchers read templates but not change them", async () => {
    expect((await researcher.get("/api/outreach/templates")).status).toBe(200);
    expect(
      (
        await researcher
          .post("/api/outreach/templates")
          .send({ name: "Nope", body: "Nope" })
      ).status,
    ).toBe(403);
  });

  it("logs a sent message as activity and moves a new lead to Contacted", async () => {
    const message = "Hi Rust Legends team, saw 12 Rust products on your site.";
    const response = await admin
      .post(`/api/leads/${leadId}/outreach`)
      .send({ channel: "discord", message, templateName: "Partnership intro" });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe("Contacted");
    const descriptions = response.body.activities.map(
      (activity: { description: string }) => activity.description,
    );
    expect(descriptions).toContain(
      `Outreach sent via Discord using "Partnership intro": ${message}`,
    );
    expect(descriptions).toContain("Status changed: New → Contacted");

    // A second message on an already-contacted lead is logged without
    // touching the stage the operator has set.
    await admin.patch(`/api/leads/${leadId}`).send({ status: "Negotiating" });
    const again = await admin
      .post(`/api/leads/${leadId}/outreach`)
      .send({ channel: "email", message: "Following up." });
    expect(again.status).toBe(201);
    expect(again.body.status).toBe("Negotiating");
  });

  it("rejects empty messages and unknown leads", async () => {
    expect(
      (
        await admin
          .post(`/api/leads/${leadId}/outreach`)
          .send({ channel: "discord", message: "   " })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin
          .post("/api/leads/does-not-exist/outreach")
          .send({ channel: "discord", message: "Hello" })
      ).status,
    ).toBe(404);
  });
});
