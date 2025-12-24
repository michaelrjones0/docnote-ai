import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2, Save, CheckCircle, Lock } from 'lucide-react';

interface NoteEditorProps {
  noteId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface NoteData {
  id: string;
  note_type: string;
  raw_content: string | null;
  content: { text?: string } | null;
  is_finalized: boolean;
  created_at: string;
  updated_at: string;
  encounters: {
    chief_complaint: string | null;
    encounter_date: string;
    patients: {
      first_name: string;
      last_name: string;
      mrn: string;
    };
  };
}

export function NoteEditor({ noteId, open, onOpenChange, onSuccess }: NoteEditorProps) {
  const [note, setNote] = useState<NoteData | null>(null);
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showFinalizeConfirm, setShowFinalizeConfirm] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (noteId && open) {
      fetchNote();
    }
  }, [noteId, open]);

  const fetchNote = async () => {
    if (!noteId) return;
    
    setIsLoading(true);
    const { data, error } = await supabase
      .from('notes')
      .select(`
        id, note_type, raw_content, content, is_finalized, created_at, updated_at,
        encounters (
          chief_complaint, encounter_date,
          patients (first_name, last_name, mrn)
        )
      `)
      .eq('id', noteId)
      .maybeSingle();

    if (error) {
      toast({ title: 'Error loading note', description: error.message, variant: 'destructive' });
      onOpenChange(false);
    } else if (data) {
      setNote(data as any);
      setContent(data.raw_content || (data.content as any)?.text || '');
    }
    setIsLoading(false);
  };

  const handleSaveDraft = async () => {
    if (!note) return;
    
    setIsSaving(true);
    const { error } = await supabase
      .from('notes')
      .update({
        raw_content: content,
        content: { text: content },
        is_finalized: false,
      })
      .eq('id', note.id);

    setIsSaving(false);

    if (error) {
      toast({ title: 'Error saving', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Draft saved' });
      onSuccess();
    }
  };

  const handleFinalize = async () => {
    if (!note) return;
    
    setIsSaving(true);
    const { error } = await supabase
      .from('notes')
      .update({
        raw_content: content,
        content: { text: content },
        is_finalized: true,
      })
      .eq('id', note.id);

    setIsSaving(false);
    setShowFinalizeConfirm(false);

    if (error) {
      toast({ title: 'Error finalizing', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Note finalized' });
      onOpenChange(false);
      onSuccess();
    }
  };

  const handleClose = () => {
    setNote(null);
    setContent('');
    onOpenChange(false);
  };

  if (!noteId) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isLoading ? 'Loading...' : note ? (
                <>
                  <Badge variant="outline">{note.note_type}</Badge>
                  {note.encounters?.patients && (
                    <span>
                      {note.encounters.patients.last_name}, {note.encounters.patients.first_name}
                    </span>
                  )}
                  {note.is_finalized ? (
                    <Badge className="ml-2">
                      <Lock className="h-3 w-3 mr-1" />
                      Finalized
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="ml-2">Draft</Badge>
                  )}
                </>
              ) : 'Note'}
            </DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : note ? (
            <>
              <div className="text-sm text-muted-foreground mb-2">
                {note.encounters?.chief_complaint && (
                  <p><strong>Chief Complaint:</strong> {note.encounters.chief_complaint}</p>
                )}
                <p><strong>Date:</strong> {new Date(note.encounters?.encounter_date || note.created_at).toLocaleDateString()}</p>
              </div>

              <div className="flex-1 overflow-hidden">
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  disabled={note.is_finalized}
                  className="h-[50vh] font-mono text-sm resize-none"
                  placeholder="Note content..."
                />
              </div>

              <DialogFooter className="pt-4">
                {note.is_finalized ? (
                  <p className="text-sm text-muted-foreground mr-auto">
                    This note has been finalized and cannot be edited.
                  </p>
                ) : (
                  <>
                    <Button variant="outline" onClick={handleSaveDraft} disabled={isSaving}>
                      {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Save Draft
                    </Button>
                    <Button onClick={() => setShowFinalizeConfirm(true)} disabled={isSaving}>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Finalize
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={showFinalizeConfirm} onOpenChange={setShowFinalizeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize Note?</AlertDialogTitle>
            <AlertDialogDescription>
              Once finalized, this note cannot be edited. This action is permanent and typically indicates the note is ready for the medical record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleFinalize}>
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Finalize Note
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
