// The dictation routes of a Tommy host.
import { HOST_VOICE_ROUTES } from "../host-voice";
import { adminRoute, boolean, empty, fields, nullable, type OptionalRouteCodec, string } from "./admin-wire";

const status = fields({ keySaved: boolean });
const stream = fields({ streamId: string(64) });
const text = fields({ text: string(200_000) });

export const HOST_VOICE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [HOST_VOICE_ROUTES.status, adminRoute(empty, status)],
  [HOST_VOICE_ROUTES.setKey, adminRoute(fields({ key: nullable(string(512)) }), status)],
  [HOST_VOICE_ROUTES.start, adminRoute(empty, stream)],
  [HOST_VOICE_ROUTES.append, adminRoute(fields({ streamId: string(64), audio: string(256_000) }), text)],
  [HOST_VOICE_ROUTES.finish, adminRoute(stream, text)],
  [HOST_VOICE_ROUTES.cancel, adminRoute(stream, empty)],
]);
