// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // ビルド成果物を検査すると、生成コードのエラーで lint が落ちる。
    ignores: [
      "build/**",
      "dist/**",
      ".react-router/**",
      ".wrangler/**",
      "node_modules/**",
      "worker-configuration.d.ts",
      "app/db/migrations/**",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // any の安易な使用を禁止する（コーディングルール §22）。
      // 抜け道が要るときは1行ごとに理由付きで disable する。
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // エラーを握りつぶさない。await 忘れは決済とメールで実害が出る。
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      // React Router は転送とエラー応答を「Response を throw する」形で扱う。
      // Error でなくても throw してよいのはこの2つだけ。
      "@typescript-eslint/only-throw-error": [
        "error",
        { allow: [{ from: "lib", name: "Response" }] },
      ],

      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // 個人情報や秘密情報がログへ出る経路を減らす。
      // 構造化ログ（app/server/logger.server.ts）を必ず通す。
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],

      // 全角空白は日本語のコメントに普通に現れる。正規表現でも
      // 「全角空白を半角へ寄せる」処理で意図して使う。コードの中に紛れ込む
      // ものだけを止めたいので、コメントと正規表現は対象から外す。
      "no-irregular-whitespace": [
        "error",
        { skipComments: true, skipRegExps: true, skipStrings: true },
      ],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // 設定・スクリプト・テストは Node で動く。console を許す。
    files: [
      "scripts/**/*",
      "test/**/*",
      "test-integration/**/*",
      "e2e/**/*",
      "*.config.{ts,mjs}",
      "vitest.*.ts",
    ],
    rules: {
      "no-console": "off",
      // 外部ライブラリ（pg / drizzle-kit / PGlite）の型が緩く、
      // 境界で any が出る。アプリ本体では禁止のまま、ここだけ許す。
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  {
    // Node で直接動かすスクリプト。型情報を伴う規則は当てない。
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // 型情報を要求しない。tsconfig の include に入れていないため、
      // projectService のままだと「プロジェクトに見つからない」で落ちる。
      parserOptions: { projectService: false, project: false },
      // globals パッケージを足さずに、実際に使うものだけを宣言する。
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
);
