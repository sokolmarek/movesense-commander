import { Link } from 'react-router-dom'
import { Page } from '@/components/page'
import { Button } from '@/components/ui/button'

export function NotFound() {
  return (
    <Page title="Not found" description="That route does not exist.">
      <Button asChild variant="secondary">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </Page>
  )
}
