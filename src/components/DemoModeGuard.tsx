import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { AlertTriangle } from 'lucide-react';

const DEMO_MODE_ACK_KEY = 'docnoteai_no_phi_ack';

export const isDemoMode = (): boolean => {
  const envValue = import.meta.env.VITE_DEMO_MODE;
  // Default to ON (safe default) if missing
  if (envValue === undefined || envValue === null || envValue === '') {
    return true;
  }
  return envValue === 'true';
};

export const getAcknowledgement = (): boolean => {
  try {
    return localStorage.getItem(DEMO_MODE_ACK_KEY) === 'true';
  } catch {
    return false;
  }
};

export const setAcknowledgement = (value: boolean): void => {
  try {
    if (value) {
      localStorage.setItem(DEMO_MODE_ACK_KEY, 'true');
    } else {
      localStorage.removeItem(DEMO_MODE_ACK_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
};

export const resetDemoAcknowledgement = (): void => {
  setAcknowledgement(false);
};

interface DemoModeGuardProps {
  children: React.ReactNode;
}

export const DemoModeGuard = ({ children }: DemoModeGuardProps) => {
  const [showModal, setShowModal] = useState(false);
  const [isChecked, setIsChecked] = useState(false);
  const [hasAcknowledged, setHasAcknowledged] = useState(true);

  useEffect(() => {
    if (isDemoMode() && !getAcknowledgement()) {
      setShowModal(true);
      setHasAcknowledged(false);
    }
  }, []);

  const handleContinue = () => {
    setAcknowledgement(true);
    setShowModal(false);
    setHasAcknowledged(true);
  };

  // Block rendering until acknowledged in demo mode
  if (isDemoMode() && !hasAcknowledged && showModal) {
    return (
      <Dialog open={showModal} onOpenChange={() => {}}>
        <DialogContent 
          className="sm:max-w-md"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Demo Environment — Do Not Use PHI
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-2">
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li>This demo is <strong>NOT HIPAA compliant</strong>.</li>
                  <li>Do NOT upload or process real patient audio, names, DOBs, MRNs, or any identifying info.</li>
                  <li>Use only synthetic or de-identified demo audio.</li>
                </ul>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center space-x-2 py-4">
            <Checkbox
              id="phi-ack"
              checked={isChecked}
              onCheckedChange={(checked) => setIsChecked(checked === true)}
            />
            <Label htmlFor="phi-ack" className="text-sm cursor-pointer">
              I understand — I will not use PHI in this demo.
            </Label>
          </div>
          <DialogFooter>
            <Button onClick={handleContinue} disabled={!isChecked} className="w-full">
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return <>{children}</>;
};

export const DemoModeBanner = () => {
  if (!isDemoMode()) {
    return null;
  }

  return (
    <div className="bg-amber-500 text-white text-center py-2 px-4 text-sm font-semibold flex items-center justify-center gap-2">
      <AlertTriangle className="h-4 w-4" />
      DEMO MODE — NO PHI
    </div>
  );
};

export const ResetDemoAckButton = ({ onReset }: { onReset?: () => void }) => {
  if (!isDemoMode()) {
    return null;
  }

  const handleReset = () => {
    resetDemoAcknowledgement();
    onReset?.();
    window.location.reload();
  };

  return (
    <button
      onClick={handleReset}
      className="text-xs text-muted-foreground hover:text-foreground underline"
    >
      Reset Demo Acknowledgement
    </button>
  );
};
