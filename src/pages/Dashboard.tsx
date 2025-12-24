import { useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users, FileText, Mic, LogOut, Settings, UserPlus } from 'lucide-react';

export default function Dashboard() {
  const { user, roles, isLoading, signOut, isProvider, isAdmin } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !user) {
      navigate('/auth');
    }
  }, [user, isLoading, navigate]);

  const handleSignOut = async () => {
    await signOut();
    navigate('/auth');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">AI Medical Scribe</h1>
            <div className="flex gap-1">
              {roles.map(role => (
                <Badge key={role} variant="secondary" className="capitalize">
                  {role}
                </Badge>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{user?.email}</span>
            <Button variant="ghost" size="icon" onClick={handleSignOut}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Link to="/patients">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
              <CardHeader>
                <Users className="h-8 w-8 text-primary mb-2" />
                <CardTitle>Patients</CardTitle>
                <CardDescription>
                  View and manage patient records, demographics, and history
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          {isProvider() && (
            <Link to="/encounters">
              <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
                <CardHeader>
                  <Mic className="h-8 w-8 text-accent mb-2" />
                  <CardTitle>Encounters</CardTitle>
                  <CardDescription>
                    Start new encounters with ambient listening and AI note generation
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          )}

          <Link to="/notes">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
              <CardHeader>
                <FileText className="h-8 w-8 text-success mb-2" />
                <CardTitle>Notes</CardTitle>
                <CardDescription>
                  View, edit, and manage clinical documentation
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          {isAdmin() && (
            <Link to="/admin">
              <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
                <CardHeader>
                  <Settings className="h-8 w-8 text-warning mb-2" />
                  <CardTitle>Admin</CardTitle>
                  <CardDescription>
                    Manage users, roles, and system settings
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}