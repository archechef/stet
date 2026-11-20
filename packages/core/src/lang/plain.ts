/** The fallback profile: any other text, reviewed by changed lines. */
import type { LanguageProfile } from "./profile.js";

export const PLAIN: LanguageProfile = {
  id: "plain",
  name: "text",
  extensions: /$^/,
  fence: "",
  document: false,
};
