import { SignIn } from "@clerk/clerk-react";

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="neon-header text-neon-green mb-2">NEONBINDER</h1>
          <p className="text-white text-lg font-medium">Welcome back</p>
          <p className="text-slate-400 mt-2">
            Sign in to access your card collection
          </p>
        </div>

        {/* Clerk Sign In Component */}
        <SignIn />
      </div>
    </div>
  );
}
