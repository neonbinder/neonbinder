import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import PrototypeBanner, { prototypeName } from "../_shared/PrototypeBanner";

/**
 * NEO-350 — collection prototype 3. Stub: the prototype's builder replaces
 * everything under the banner.
 */
export default function CollectionPrototype3() {
  const name = prototypeName(3);
  useDocumentTitle(`${name} · Collection prototype`);
  return (
    <div>
      <PrototypeBanner current={3} />
      <h1 className="text-3xl font-bold text-white">{name}</h1>
    </div>
  );
}
