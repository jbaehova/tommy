import { IPC_ENDPOINTS } from "@tommy/contracts/ipc";
import type { HostSkillLearning } from "@tommy/contracts/ipc-skill-learning";
import { SKILL_LEARNING_CODECS, SKILL_LEARNING_ROUTES } from "@tommy/contracts/team-protocol/skill-learning-v1";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { RemoteWorkflowError } from "../remote-service-effects";
import { type SkillLearningIpcDependencies, skillLearningIpcHandlers } from "./skill-learning-handlers";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, payload: unknown) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const TRUSTED = { senderFrame: { url: "tommy-app://app/index.html" } };
const UNTRUSTED = { senderFrame: { url: "https://example.com/" } };
const settings: HostSkillLearning = { mode: "ask", choices: ["ask", "automatic", "off"] };
const unused = () => Effect.die(new Error("This request must stay on the remote host."));

function bind(supported = true) {
  registrations.clear();
  const requests: string[] = [];
  const dependencies: SkillLearningIpcDependencies = {
    skillLearning: {
      snapshot: () => {
        throw new Error("A remote query must not read local settings.");
      },
      set: unused,
      restore: unused,
      listLocalSkills: unused,
      readLocalSkill: unused,
    },
    saveSuggestion: unused,
    remoteServers: {
      supportsCapability: () => supported,
      request: (serverId, path, decode, init) =>
        Effect.try({
          try: () => {
            expect(serverId).toBe("remote-example");
            expect(init?.method).toBe("POST");
            const codec = SKILL_LEARNING_CODECS.get(path);
            if (!codec) throw new Error("The request has no negotiated wire codec.");
            codec.request(init?.body);
            requests.push(path);
            return decode(codec.response(200, path === SKILL_LEARNING_ROUTES.settings ? settings : []));
          },
          catch: (cause) => new RemoteWorkflowError({ cause }),
        }),
    },
  };
  const { skillLearning } = skillLearningIpcHandlers(dependencies);
  skillLearning.get(IPC_ENDPOINTS.skillLearning.get.channel);
  skillLearning.listLocal(IPC_ENDPOINTS.skillLearning.listLocal.channel);
  return requests;
}

function invoke(channel: string, event = TRUSTED) {
  const listener = registrations.get(channel);
  if (!listener) throw new Error("The IPC handler was not registered.");
  return listener(event, { serverId: "remote-example", payload: null });
}

describe("remote skill learning query boundaries", () => {
  it("reads settings and revision metadata through the negotiated empty-record codec", async () => {
    const requests = bind();
    await expect(invoke(IPC_ENDPOINTS.skillLearning.get.channel)).resolves.toEqual(settings);
    await expect(invoke(IPC_ENDPOINTS.skillLearning.listLocal.channel)).resolves.toEqual([]);
    expect(requests).toEqual([SKILL_LEARNING_ROUTES.settings, SKILL_LEARNING_ROUTES.listLocal]);
  });

  it("refuses an unsupported host before sending the request", () => {
    const requests = bind(false);
    expect(() => invoke(IPC_ENDPOINTS.skillLearning.get.channel)).toThrow(
      "Agent settings are not supported by this connection.",
    );
    expect(requests).toEqual([]);
  });

  it("refuses an untrusted renderer before contacting the host", () => {
    const requests = bind();
    expect(() => invoke(IPC_ENDPOINTS.skillLearning.listLocal.channel, UNTRUSTED)).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(requests).toEqual([]);
  });
});
