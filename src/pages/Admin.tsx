import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, AppRole } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Shield, Users, Loader2, Plus, Trash2 } from 'lucide-react';

interface UserWithRoles {
  id: string;
  email: string;
  full_name: string;
  roles: AppRole[];
}

export default function Admin() {
  const [users, setUsers] = useState<UserWithRoles[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);

  const { user, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (!authLoading) {
      if (!user) {
        navigate('/auth');
      } else if (!isAdmin()) {
        navigate('/dashboard');
        toast({ title: 'Access denied', description: 'Admin role required.', variant: 'destructive' });
      }
    }
  }, [user, authLoading, isAdmin, navigate, toast]);

  useEffect(() => {
    if (user && isAdmin()) {
      fetchUsers();
    }
  }, [user]);

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      // Fetch profiles
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('user_id, email, full_name')
        .order('full_name');

      if (profileError) throw profileError;

      // Fetch all roles
      const { data: allRoles, error: rolesError } = await supabase
        .from('user_roles')
        .select('user_id, role');

      if (rolesError) throw rolesError;

      // Combine profiles with roles
      const usersWithRoles: UserWithRoles[] = (profiles || []).map(profile => ({
        id: profile.user_id,
        email: profile.email,
        full_name: profile.full_name,
        roles: (allRoles || [])
          .filter(r => r.user_id === profile.user_id)
          .map(r => r.role as AppRole),
      }));

      setUsers(usersWithRoles);
    } catch (err) {
      console.error('Error fetching users:', err);
      toast({ title: 'Error loading users', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddRole = async (userId: string, role: AppRole) => {
    setUpdatingUser(userId);
    try {
      const { error } = await supabase
        .from('user_roles')
        .insert({ user_id: userId, role });

      if (error) {
        if (error.code === '23505') {
          toast({ title: 'Role already assigned', variant: 'destructive' });
        } else {
          throw error;
        }
      } else {
        toast({ title: 'Role added successfully' });
        fetchUsers();
      }
    } catch (err) {
      console.error('Error adding role:', err);
      toast({ title: 'Failed to add role', variant: 'destructive' });
    } finally {
      setUpdatingUser(null);
    }
  };

  const handleRemoveRole = async (userId: string, role: AppRole) => {
    // Prevent removing your own admin role
    if (userId === user?.id && role === 'admin') {
      toast({ title: 'Cannot remove your own admin role', variant: 'destructive' });
      return;
    }

    setUpdatingUser(userId);
    try {
      const { error } = await supabase
        .from('user_roles')
        .delete()
        .eq('user_id', userId)
        .eq('role', role);

      if (error) throw error;

      toast({ title: 'Role removed successfully' });
      fetchUsers();
    } catch (err) {
      console.error('Error removing role:', err);
      toast({ title: 'Failed to remove role', variant: 'destructive' });
    } finally {
      setUpdatingUser(null);
    }
  };

  const getRoleBadgeVariant = (role: AppRole) => {
    switch (role) {
      case 'admin': return 'destructive';
      case 'provider': return 'default';
      case 'staff': return 'secondary';
      default: return 'outline';
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Shield className="h-5 w-5 text-warning" />
          <h1 className="text-xl font-semibold">Admin Panel</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              User Role Management
            </CardTitle>
            <CardDescription>
              Manage user roles. Providers can create encounters, Staff can view data, Admins have full access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Current Roles</TableHead>
                  <TableHead>Add Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.full_name}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {u.roles.map((role) => (
                          <Badge 
                            key={role} 
                            variant={getRoleBadgeVariant(role)}
                            className="gap-1 cursor-pointer hover:opacity-80"
                            onClick={() => handleRemoveRole(u.id, role)}
                          >
                            {role}
                            <Trash2 className="h-3 w-3" />
                          </Badge>
                        ))}
                        {u.roles.length === 0 && (
                          <span className="text-sm text-muted-foreground">No roles</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value=""
                        onValueChange={(v) => handleAddRole(u.id, v as AppRole)}
                        disabled={updatingUser === u.id}
                      >
                        <SelectTrigger className="w-32 h-8">
                          <SelectValue placeholder={
                            updatingUser === u.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <span className="flex items-center gap-1">
                                <Plus className="h-3 w-3" /> Add
                              </span>
                            )
                          } />
                        </SelectTrigger>
                        <SelectContent>
                          {!u.roles.includes('admin') && (
                            <SelectItem value="admin">Admin</SelectItem>
                          )}
                          {!u.roles.includes('provider') && (
                            <SelectItem value="provider">Provider</SelectItem>
                          )}
                          {!u.roles.includes('staff') && (
                            <SelectItem value="staff">Staff</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
                {users.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      No users found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}