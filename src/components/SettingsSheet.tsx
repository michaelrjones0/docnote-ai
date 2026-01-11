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
import { Settings, Loader2, KeyRound, FileText } from 'lucide-react';
import { PhysicianPreferences, NoteEditorMode } from '@/hooks/usePhysicianPreferences';

interface SettingsSheetProps {
  preferences: PhysicianPreferences;
  setPreferences: (updates: Partial<PhysicianPreferences>) => void;
}

export function SettingsSheet({ preferences, setPreferences }: SettingsSheetProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  
  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

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

          <Separator />

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
        </div>
      </SheetContent>
    </Sheet>
  );
}
