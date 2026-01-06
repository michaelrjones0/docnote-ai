import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

const Index = () => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-6">
        <h1 className="text-4xl font-bold">AI Medical Scribe</h1>
        <p className="text-xl text-muted-foreground">Streamline your clinical documentation</p>
        <Button asChild size="lg">
          <Link to="/login">Log In</Link>
        </Button>
      </div>
    </div>
  );
};

export default Index;
