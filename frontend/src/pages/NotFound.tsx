import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { EmptyState } from "../components/ui";

export function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="This route is not part of the assurance network"
      description="The page you requested does not exist. Return to the executive overview to continue."
      action={
        <Link to="/" className="button button-primary button-md">
          Return to overview
        </Link>
      }
    />
  );
}
