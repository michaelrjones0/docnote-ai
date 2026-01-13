import * as React from "react";
import { cn } from "@/lib/utils";

export interface RichSoapTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** When true, renders complaint headers (ALL CAPS:) as bold and underlined */
  enableRichDisplay?: boolean;
}

/**
 * Parses text to find problem/complaint headers (word(s) followed by colon at start of line)
 * and converts them to styled spans with bold formatting
 */
const parseHeaderText = (text: string): React.ReactNode[] => {
  if (!text) return [];
  
  // Pattern: Line starts with one or more words (Title Case, ALL CAPS, or mixed) followed by a colon
  // e.g., "Low Back Pain:" or "HEADACHES:" or "Hypertension:"
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  
  lines.forEach((line, lineIndex) => {
    // Check if line starts with a header pattern
    // Pattern: Words (letters, spaces, hyphens, slashes, ampersands, numbers) followed by colon
    // Must start with a capital letter
    const headerMatch = line.match(/^([A-Z][A-Za-z0-9\s/&-]*):(.*)$/);
    
    if (headerMatch) {
      const [, header, rest] = headerMatch;
      result.push(
        <React.Fragment key={lineIndex}>
          <span className="font-bold">{header}:</span>
          {rest}
          {lineIndex < lines.length - 1 && '\n'}
        </React.Fragment>
      );
    } else {
      result.push(
        <React.Fragment key={lineIndex}>
          {line}
          {lineIndex < lines.length - 1 && '\n'}
        </React.Fragment>
      );
    }
  });
  
  return result;
};

const RichSoapTextarea = React.forwardRef<HTMLTextAreaElement, RichSoapTextareaProps>(
  ({ className, onChange, value, enableRichDisplay = false, ...props }, ref) => {
    const [isEditing, setIsEditing] = React.useState(false);
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const containerRef = React.useRef<HTMLDivElement | null>(null);

    const adjustHeight = () => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    };

    React.useEffect(() => {
      adjustHeight();
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      adjustHeight();
      onChange?.(e);
    };

    const setRefs = (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    };

    const handleDisplayClick = () => {
      setIsEditing(true);
      // Focus textarea after state update
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
    };

    const handleBlur = () => {
      setIsEditing(false);
    };

    const textValue = typeof value === 'string' ? value : '';

    // If rich display is not enabled, just render the standard textarea
    if (!enableRichDisplay) {
      return (
        <textarea
          ref={setRefs}
          className={cn(
            "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            "overflow-hidden resize-none",
            className
          )}
          onChange={handleChange}
          value={value}
          {...props}
        />
      );
    }

    return (
      <div ref={containerRef} className="relative">
        {/* Rich display layer - shown when not editing */}
        {!isEditing && (
          <div
            onClick={handleDisplayClick}
            className={cn(
              "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm cursor-text whitespace-pre-wrap",
              "hover:border-ring/50 transition-colors",
              props.disabled && "cursor-not-allowed opacity-50",
              className
            )}
          >
          {textValue ? (
              parseHeaderText(textValue)
            ) : (
              <span className="text-muted-foreground">{props.placeholder}</span>
            )}
          </div>
        )}
        
        {/* Editable textarea - shown when editing */}
        <textarea
          ref={setRefs}
          className={cn(
            "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            "overflow-hidden resize-none",
            !isEditing && "sr-only",
            className
          )}
          onChange={handleChange}
          onBlur={handleBlur}
          value={value}
          {...props}
        />
      </div>
    );
  }
);

RichSoapTextarea.displayName = "RichSoapTextarea";

export { RichSoapTextarea };
