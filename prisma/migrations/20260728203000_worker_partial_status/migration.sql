-- A worker cycle can complete its independent stages while retaining one or
-- more isolated stage failures.
ALTER TYPE "AutomationRunStatus" ADD VALUE 'PARTIAL';
