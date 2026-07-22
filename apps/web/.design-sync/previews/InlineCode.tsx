import { InlineCode } from "neonbinder";

export const Default = () => (
  <p className="text-sm text-slate-700 max-w-md">
    Set the <InlineCode>NEONBINDER_BROWSER_URL</InlineCode> environment
    variable before running <InlineCode>npm run dev:all</InlineCode>, or
    marketplace sync calls will fall back to{" "}
    <InlineCode>http://localhost:8080</InlineCode>.
  </p>
);
