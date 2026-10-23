import { SignIn } from "@clerk/clerk-react";

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="neon-header text-neon-green-text mb-2">NEONBINDER</h1>
          <p className="text-ink text-lg font-medium">Welcome back</p>
          <p className="text-ink-3 mt-2">
            Sign in to access your card collection
          </p>
        </div>

        {/* Clerk Sign In Component */}
        <SignIn />
      </div>
    </div>
  );
}
