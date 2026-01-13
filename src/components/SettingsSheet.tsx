import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { Settings, Loader2, KeyRound, FileText, ClipboardList, Plus, Trash2, Star, Pencil, Check, X } from 'lucide-react';
import { PhysicianPreferences, NoteEditorMode, PhysicalExamTemplate } from '@/hooks/usePhysicianPreferences';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';

interface SettingsSheetProps {
  preferences: PhysicianPreferences;
  setPreferences: (updates: Partial<PhysicianPreferences>) => void;
  addTemplate: (name: string, content: string) => void;
  updateTemplate: (id: string, updates: Partial<Omit<PhysicalExamTemplate, 'id'>>) => void;
  deleteTemplate: (id: string) => void;
  setDefaultTemplate: (id: string) => void;
}

export function SettingsSheet({ 
  preferences, 
  setPreferences, 
  addTemplate, 
  updateTemplate, 
  deleteTemplate, 
  setDefaultTemplate 
}: SettingsSheetProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  
  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // Template editing state
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingTemplateName, setEditingTemplateName] = useState('');
  const [editingTemplateContent, setEditingTemplateContent] = useState('');
  
  // New template state
  const [isAddingTemplate, setIsAddingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateContent, setNewTemplateContent] = useState('');

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) {
      toast({
        title: 'Passwords do not match',
        description: 'Please make sure both new passwords are the same.',
        variant: 'destructive',
      });
      return;
    }

    if (newPassword.length < 6) {
      toast({
        title: 'Password too short',
        description: 'Password must be at least 6 characters.',
        variant: 'destructive',
      });
      return;
    }

    setIsChangingPassword(true);

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });

      if (error) {
        toast({
          title: 'Password change failed',
          description: error.message,
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Password updated',
          description: 'Your password has been successfully changed.',
        });
        // Clear form
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      }
    } catch (err) {
      toast({
        title: 'Error',
        description: String(err),
        variant: 'destructive',
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings className="h-4 w-4 mr-2" />
          Settings
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[400px] sm:w-[540px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>
            Manage your account and note preferences
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Note Preferences Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-medium">SOAP Note Preferences</h3>
            </div>

            <div className="space-y-4">
              {/* Editor Mode */}
              <div className="space-y-2">
                <Label htmlFor="noteEditorMode" className="text-sm">Editor Mode</Label>
                <Select
                  value={preferences.noteEditorMode}
                  onValueChange={(value: NoteEditorMode) => 
                    setPreferences({ noteEditorMode: value })
                  }
                >
                  <SelectTrigger id="noteEditorMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SOAP_4_FIELD">SOAP (4 fields: S / O / A / P)</SelectItem>
                    <SelectItem value="SOAP_3_FIELD">SOAP (3 fields: S / O / A&P combined)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Note Structure */}
              <div className="space-y-2">
                <Label htmlFor="noteStructure" className="text-sm">Note Structure</Label>
                <Select
                  value={preferences.noteStructure}
                  onValueChange={(value: 'SOAP' | 'Problem-Oriented') => 
                    setPreferences({ noteStructure: value })
                  }
                >
                  <SelectTrigger id="noteStructure">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SOAP">SOAP</SelectItem>
                    <SelectItem value="Problem-Oriented">Problem-Oriented</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Detail Level */}
              <div className="space-y-2">
                <Label htmlFor="detailLevel" className="text-sm">Detail Level</Label>
                <Select
                  value={preferences.detailLevel}
                  onValueChange={(value: 'Brief' | 'Standard' | 'Detailed') => 
                    setPreferences({ detailLevel: value })
                  }
                >
                  <SelectTrigger id="detailLevel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Brief">Brief</SelectItem>
                    <SelectItem value="Standard">Standard</SelectItem>
                    <SelectItem value="Detailed">Detailed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Plan Format */}
              <div className="space-y-2">
                <Label htmlFor="planFormat" className="text-sm">Plan Format</Label>
                <Select
                  value={preferences.planFormat}
                  onValueChange={(value: 'Bullets' | 'Paragraph') => 
                    setPreferences({ planFormat: value })
                  }
                >
                  <SelectTrigger id="planFormat">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Bullets">Bullets</SelectItem>
                    <SelectItem value="Paragraph">Paragraph</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Toggle switches */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label htmlFor="firstPerson" className="text-sm cursor-pointer">
                    First-person clinician voice
                  </Label>
                  <Switch
                    id="firstPerson"
                    checked={preferences.firstPerson}
                    onCheckedChange={(checked) => setPreferences({ firstPerson: checked })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="patientQuotes" className="text-sm cursor-pointer">
                    Include patient quotes
                  </Label>
                  <Switch
                    id="patientQuotes"
                    checked={preferences.patientQuotes}
                    onCheckedChange={(checked) => setPreferences({ patientQuotes: checked })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="assessmentProblemList" className="text-sm cursor-pointer">
                    Assessment as problem list
                  </Label>
                  <Switch
                    id="assessmentProblemList"
                    checked={preferences.assessmentProblemList}
                    onCheckedChange={(checked) => setPreferences({ assessmentProblemList: checked })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="includeFollowUpLine" className="text-sm cursor-pointer">
                    Plan includes follow-up line
                  </Label>
                  <Switch
                    id="includeFollowUpLine"
                    checked={preferences.includeFollowUpLine}
                    onCheckedChange={(checked) => setPreferences({ includeFollowUpLine: checked })}
                  />
                </div>
              </div>

              <Separator />

              {/* Clinician Signature */}
              <div className="space-y-2">
                <Label htmlFor="clinicianDisplayName" className="text-sm">
                  Clinician Name (for signature)
                </Label>
                <Input
                  id="clinicianDisplayName"
                  value={preferences.clinicianDisplayName}
                  onChange={(e) => setPreferences({ clinicianDisplayName: e.target.value })}
                  placeholder="e.g., Dr. Jane Smith"
                  className="text-sm"
                />
              </div>

              {/* Custom Style Instructions */}
              <div className="space-y-2">
                <Label htmlFor="styleText" className="text-sm">My style preferences (optional)</Label>
                <AutoResizeTextarea
                  id="styleText"
                  value={preferences.styleText}
                  onChange={(e) => setPreferences({ styleText: e.target.value })}
                  placeholder="Examples:
• Keep assessment as problem list, no sentences.
• Plan should include return precautions when mentioned.
• Avoid filler like 'patient presents today'."
                  className="min-h-[80px] text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Style only. Cannot add facts not in transcript. ({preferences.styleText.length}/600)
                </p>
              </div>
            </div>
          </div>

          <Separator />

          {/* Physical Exam Templates Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-muted-foreground" />
                <h3 className="font-medium">Physical Exam Templates</h3>
              </div>
              {preferences.physicalExamTemplates.length < 10 && !isAddingTemplate && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setIsAddingTemplate(true);
                    setNewTemplateName('');
                    setNewTemplateContent('');
                  }}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add Template
                </Button>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Create templates for different specialties. When generating notes, findings from the transcript will be merged into the selected template. Templates with ⭐ are the default.
            </p>

            {/* Add New Template Form */}
            {isAddingTemplate && (
              <div className="border rounded-lg p-3 space-y-3 bg-muted/50">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">New Template</Label>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      onClick={() => {
                        if (newTemplateName.trim() && newTemplateContent.trim()) {
                          addTemplate(newTemplateName.trim(), newTemplateContent.trim());
                          setIsAddingTemplate(false);
                          setNewTemplateName('');
                          setNewTemplateContent('');
                          toast({ title: 'Template created', description: `"${newTemplateName.trim()}" has been added.` });
                        }
                      }}
                      disabled={!newTemplateName.trim() || !newTemplateContent.trim()}
                    >
                      <Check className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      onClick={() => {
                        setIsAddingTemplate(false);
                        setNewTemplateName('');
                        setNewTemplateContent('');
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <Input
                  value={newTemplateName}
                  onChange={(e) => setNewTemplateName(e.target.value)}
                  placeholder="Template name (e.g., Cardiology, Pediatrics)"
                  className="text-sm"
                />
                <AutoResizeTextarea
                  value={newTemplateContent}
                  onChange={(e) => setNewTemplateContent(e.target.value)}
                  placeholder="Enter physical exam template content..."
                  className="min-h-[100px] text-sm font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {newTemplateContent.length}/2000 characters
                </p>
              </div>
            )}

            {/* Template List */}
            <div className="space-y-3">
              {preferences.physicalExamTemplates.map((template) => (
                <div key={template.id} className="border rounded-lg p-3 space-y-2">
                  {editingTemplateId === template.id ? (
                    // Editing mode
                    <>
                      <div className="flex items-center justify-between">
                        <Input
                          value={editingTemplateName}
                          onChange={(e) => setEditingTemplateName(e.target.value)}
                          className="text-sm font-medium h-8 flex-1 mr-2"
                        />
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            onClick={() => {
                              if (editingTemplateName.trim()) {
                                updateTemplate(template.id, {
                                  name: editingTemplateName.trim(),
                                  content: editingTemplateContent,
                                });
                                setEditingTemplateId(null);
                                toast({ title: 'Template updated' });
                              }
                            }}
                            disabled={!editingTemplateName.trim()}
                          >
                            <Check className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            onClick={() => setEditingTemplateId(null)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      <AutoResizeTextarea
                        value={editingTemplateContent}
                        onChange={(e) => setEditingTemplateContent(e.target.value)}
                        className="min-h-[100px] text-sm font-mono"
                      />
                      <p className="text-xs text-muted-foreground">
                        {editingTemplateContent.length}/2000 characters
                      </p>
                    </>
                  ) : (
                    // View mode
                    <>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{template.name}</span>
                          {template.id === preferences.defaultPhysicalExamTemplateId && (
                            <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
                          )}
                        </div>
                        <div className="flex gap-1">
                          {template.id !== preferences.defaultPhysicalExamTemplateId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => {
                                setDefaultTemplate(template.id);
                                toast({ title: 'Default template updated', description: `"${template.name}" is now the default.` });
                              }}
                              title="Set as default"
                            >
                              <Star className="h-3 w-3" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              setEditingTemplateId(template.id);
                              setEditingTemplateName(template.name);
                              setEditingTemplateContent(template.content);
                            }}
                            title="Edit template"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          {preferences.physicalExamTemplates.length > 1 && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs text-destructive hover:text-destructive"
                                  title="Delete template"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete template?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Are you sure you want to delete "{template.name}"? This action cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => {
                                      deleteTemplate(template.id);
                                      toast({ title: 'Template deleted' });
                                    }}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-3 font-mono whitespace-pre-wrap">
                        {template.content.slice(0, 200)}{template.content.length > 200 ? '...' : ''}
                      </p>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Change Password Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-medium">Change Password</h3>
            </div>
            
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="new-password" className="text-sm">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password" className="text-sm">Confirm New Password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <Button 
                onClick={handleChangePassword} 
                disabled={isChangingPassword || !newPassword || !confirmPassword}
                className="w-full"
              >
                {isChangingPassword ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Update Password
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
