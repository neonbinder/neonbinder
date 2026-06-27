import { RectangleStackIcon } from "@heroicons/react/24/outline";

export default function CollectionPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      <RectangleStackIcon className="w-16 h-16 text-neon-blue mb-6" />
      <h1
        className="text-4xl font-bold mb-4 text-transparent bg-clip-text bg-gradient-to-r from-neon-blue to-neon-green"
        style={{ fontFamily: "'Lexend', sans-serif" }}
      >
        Your Collection
      </h1>
      <p className="text-lg text-slate-400 max-w-md">
        Your card collection management is coming soon. Track, organize, and
        manage your entire inventory from right here.
      </p>
      <p
        className="text-neon-blue font-semibold mt-6"
        style={{ textShadow: "0 0 10px rgba(0, 194, 255, 0.4)" }}
      >
        Stay tuned!
      </p>
    </div>
  );
}
