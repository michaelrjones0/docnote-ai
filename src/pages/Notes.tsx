import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NoteEditor } from '@/components/notes/NoteEditor';
import { ArrowLeft, FileText, Loader2, Lock, Edit } from 'lucide-react';

interface Note {
  id: string;
  note_type: string;
  is_finalized: boolean;
  created_at: string;
  encounters: {
    chief_complaint: string;
    patients: {
      first_name: string;
      last_name: string;
      mrn: string;
    };
  };
}

export default function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      fetchNotes();
    }
  }, [user]);

  const fetchNotes = async () => {
    const { data, error } = await supabase
      .from('notes')
      .select(`
        id, note_type, is_finalized, created_at,
        encounters (
          chief_complaint,
          patients (first_name, last_name, mrn)
        )
      `)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!error && data) {
      setNotes(data as any);
    }
    setIsLoading(false);
  };

  const handleOpenNote = (noteId: string) => {
    setSelectedNoteId(noteId);
    setIsEditorOpen(true);
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
          <h1 className="text-xl font-semibold">Clinical Notes</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Chief Complaint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notes.map((note) => (
                <TableRow key={note.id} className="cursor-pointer hover:bg-muted/50" onClick={() => handleOpenNote(note.id)}>
                  <TableCell>{new Date(note.created_at).toLocaleDateString()}</TableCell>
                  <TableCell className="font-medium">
                    {note.encounters?.patients?.last_name}, {note.encounters?.patients?.first_name}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{note.note_type}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {note.encounters?.chief_complaint || '-'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={note.is_finalized ? 'default' : 'secondary'} className="gap-1">
                      {note.is_finalized && <Lock className="h-3 w-3" />}
                      {note.is_finalized ? 'Finalized' : 'Draft'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleOpenNote(note.id); }}>
                      <Edit className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {notes.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    No notes yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </main>

      <NoteEditor
        noteId={selectedNoteId}
        open={isEditorOpen}
        onOpenChange={setIsEditorOpen}
        onSuccess={fetchNotes}
      />
    </div>
  );
}
