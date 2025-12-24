import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Loader2, ChevronDown, ChevronRight, History, Brain, Search, AlertCircle } from 'lucide-react';
import { useState } from 'react';

interface PreviousVisit {
  id: string;
  date: string;
  chiefComplaint: string;
  noteType: string;
  summary?: string;
  content: string;
}

interface ChronicCondition {
  id: string;
  condition_name: string;
  icd_code?: string;
  is_chronic: boolean;
  notes?: string;
}

interface AIContextAnalysis {
  analysis: string;
  hasRelevantHistory: boolean;
}

interface PreviousVisitsPanelProps {
  previousVisits: PreviousVisit[];
  chronicConditions: ChronicCondition[];
  aiContextAnalysis: AIContextAnalysis | null;
  isLoadingVisits: boolean;
  isLoadingContext: boolean;
  onSearchContext: () => void;
  chiefComplaint: string;
}

export function PreviousVisitsPanel({
  previousVisits,
  chronicConditions,
  aiContextAnalysis,
  isLoadingVisits,
  isLoadingContext,
  onSearchContext,
  chiefComplaint,
}: PreviousVisitsPanelProps) {
  const [expandedVisit, setExpandedVisit] = useState<string | null>(null);

  const hasChronicConditions = chronicConditions.some(c => c.is_chronic);

  return (
    <div className="space-y-4">
      {/* Chronic Conditions */}
      {chronicConditions.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-warning" />
              Active Conditions
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <div className="flex flex-wrap gap-2">
              {chronicConditions.map((condition) => (
                <Badge 
                  key={condition.id} 
                  variant={condition.is_chronic ? 'default' : 'secondary'}
                  className="text-xs"
                >
                  {condition.condition_name}
                  {condition.icd_code && (
                    <span className="ml-1 opacity-70">({condition.icd_code})</span>
                  )}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* AI Context Analysis */}
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Brain className="h-4 w-4 text-accent" />
              AI Context Search
            </CardTitle>
            {!hasChronicConditions && (
              <Button 
                size="sm" 
                variant="outline" 
                onClick={onSearchContext}
                disabled={isLoadingContext || !chiefComplaint}
                className="h-7 text-xs"
              >
                {isLoadingContext ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Search className="h-3 w-3 mr-1" />
                )}
                Pull Context
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="py-2">
          {isLoadingContext ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching patient history...
            </div>
          ) : aiContextAnalysis ? (
            <ScrollArea className="h-[200px]">
              <div className="prose prose-sm max-w-none text-sm">
                <div 
                  className="whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{ 
                    __html: aiContextAnalysis.analysis
                      .replace(/^## /gm, '<h4 class="font-semibold mt-3 mb-1">')
                      .replace(/^### /gm, '<h5 class="font-medium mt-2 mb-1">')
                      .replace(/\n/g, '<br/>') 
                  }}
                />
              </div>
            </ScrollArea>
          ) : (
            <p className="text-sm text-muted-foreground py-2">
              {hasChronicConditions 
                ? 'Context will load automatically when you enter a chief complaint.'
                : 'Click "Pull Context" to search patient history for relevant information.'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Previous Visits Timeline */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            Previous Visits ({previousVisits.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="py-2">
          {isLoadingVisits ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading visit history...
            </div>
          ) : previousVisits.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No previous visits on record.
            </p>
          ) : (
            <ScrollArea className="h-[250px]">
              <div className="space-y-2">
                {previousVisits.map((visit) => (
                  <Collapsible
                    key={visit.id}
                    open={expandedVisit === visit.id}
                    onOpenChange={(open) => setExpandedVisit(open ? visit.id : null)}
                  >
                    <CollapsibleTrigger asChild>
                      <div className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 cursor-pointer">
                        {expandedVisit === visit.id ? (
                          <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium">{visit.date}</span>
                            <Badge variant="outline" className="text-xs h-5">
                              {visit.noteType}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground truncate">
                            {visit.chiefComplaint}
                          </p>
                          {visit.summary && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {visit.summary}
                            </p>
                          )}
                        </div>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-6 p-3 bg-muted/30 rounded-md mt-1 mb-2">
                        <ScrollArea className="h-[150px]">
                          <pre className="text-xs whitespace-pre-wrap font-mono">
                            {visit.content}
                          </pre>
                        </ScrollArea>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}