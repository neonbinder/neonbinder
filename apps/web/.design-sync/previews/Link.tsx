import { Link } from "neonbinder";

// Link renders react-router's <Link> internally whenever no onClick prop is
// passed, which needs Router context (provided by <BrowserRouter> in the
// real app's src/main.tsx). A static preview can't share that context with
// the compiled bundle's own react-router copy (only react/react-dom get
// singleton treatment across bundle + preview builds — see NOTES.md), so
// every cell here uses the onClick branch instead: a real, fully-supported
// code path of this component, not a workaround.
export const Default = () => (
  <Link href="#" onClick={() => {}}>
    View Collection
  </Link>
);

export const InlineText = () => (
  <p className="text-sm text-slate-700 max-w-sm">
    Your listing for the 2023 Bowman Chrome Julio Rodriguez PSA 10 synced to{" "}
    <Link href="#" onClick={() => {}}>
      eBay
    </Link>{" "}
    and{" "}
    <Link href="#" onClick={() => {}}>
      SportLots
    </Link>{" "}
    successfully.
  </p>
);

export const OnClickHandler = () => (
  <Link href="#" onClick={() => {}}>
    Remove from binder
  </Link>
);
