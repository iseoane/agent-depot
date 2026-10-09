import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["src/**/*.{ts,tsx}", "resources/pi/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
  extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
});
