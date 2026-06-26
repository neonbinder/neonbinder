import { useAuth } from "@clerk/clerk-react";
import { useNavigate } from "react-router";
import { useEffect } from "react";
import LandingPage from "./landing";

export default function Home() {
  const { isSignedIn, isLoaded } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      navigate("/dashboard");
    }
  }, [isLoaded, isSignedIn, navigate]);

  // Show loading state while checking auth
  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
          <p className="text-slate-600 dark:text-slate-400">Loading...</p>
        </div>
      </div>
    );
  }

  // If signed in, show nothing (redirect will happen)
  if (isSignedIn) {
    return null;
  }

  // Show landing page for signed out users
  return <LandingPage />;
}
