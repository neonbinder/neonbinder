import { SignUp } from "@clerk/clerk-react";

export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="neon-header text-neon-green mb-2">NEONBINDER</h1>
          <p className="text-white text-lg font-medium">Join the collection</p>
          <p className="text-slate-400 mt-2">
            Create your account to start collecting
          </p>
        </div>

        {/* Clerk Sign Up Component */}
        <SignUp />
      </div>
    </div>
  );
}
