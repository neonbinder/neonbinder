import { SignUp } from "@clerk/clerk-react";

export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="neon-header text-neon-green-text mb-2">NEONBINDER</h1>
          <p className="text-ink text-lg font-medium">Join the collection</p>
          <p className="text-ink-3 mt-2">
            Create your account to start collecting
          </p>
        </div>

        {/* Clerk Sign Up Component */}
        <SignUp />
      </div>
    </div>
  );
}
