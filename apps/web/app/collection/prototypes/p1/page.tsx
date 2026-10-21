import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import PrototypeBanner, { prototypeName } from "../_shared/PrototypeBanner";

/**
 * NEO-350 — collection prototype 1. Stub: the prototype's builder replaces
 * everything under the banner.
 */
export default function CollectionPrototype1() {
  const name = prototypeName(1);
  useDocumentTitle(`${name} · Collection prototype`);
  return (
    <div>
      <PrototypeBanner current={1} />
      <h1 className="text-3xl font-bold text-white">{name}</h1>
    </div>
  );
}
