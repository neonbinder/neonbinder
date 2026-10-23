import { ArchiveBoxIcon } from "@heroicons/react/24/outline";

export default function InventoryPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <ArchiveBoxIcon className="w-16 h-16 text-neon-yellow-text mb-6" />
      <h1
        className="text-4xl font-bold mb-4 text-neon-yellow-text"
        style={{ fontFamily: "'Lexend', sans-serif" }}
      >
        Your Inventory
      </h1>
      <p className="text-lg text-ink-3 max-w-md">
        Inventory management is coming soon. List your cards across all
        platforms and track stock from one place.
      </p>
      <p
        className="text-neon-yellow-text font-semibold mt-6"
        style={{ textShadow: "0 0 10px rgb(255 230 0 / calc(0.4 * var(--glow)))" }}
      >
        Stay tuned!
      </p>
    </div>
  );
}
