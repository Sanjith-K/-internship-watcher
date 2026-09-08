import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests
import watcher
import notion_sync as notion
from job_utils import (canonical_url, job_identity, fingerprint, term_matches,
                       categorize, load_json)


def job(jid='greenhouse:example:123', **kwargs):
    base = dict(id=jid, company='Example', title='SWE Intern', location='Austin, TX',
                url='https://boards.greenhouse.io/example/jobs/123')
    base.update(kwargs)
    return base


def page(j, status='Saved', pid='page-1'):
    return {'id': pid, 'properties': {
        'Link': {'url': j['url']}, 'Status': {'select': {'name': status}},
        'Role': {'title': [{'plain_text': j['title']}]}}}


class IdentityTests(unittest.TestCase):
    def test_preserves_job_query_and_fragments(self):
        url = 'https://careers.example.com/job?gh_jid=123&utm_source=mail&lang=en#/apply'
        clean = canonical_url(url)
        self.assertIn('gh_jid=123', clean)
        self.assertIn('lang=en', clean)
        self.assertTrue(clean.endswith('#/apply'))
        self.assertNotIn('utm_source', clean)
        self.assertNotEqual(clean, canonical_url(url.replace('123', '456')))

    def test_greenhouse_custom_domain_and_native_identity(self):
        j = job()
        other = {**j, 'url': 'https://careers.example.com/job?gh_jid=123'}
        self.assertEqual(job_identity(j), job_identity(other))

    def test_term_filter_all_sources_and_unknown(self):
        j = job()
        j['title'] = 'Summer 2026 SWE Intern'
        self.assertFalse(term_matches(j, ['Summer 2027']))
        j['title'] = 'SWE Intern'
        self.assertTrue(term_matches(j, ['Summer 2027']))
        self.assertFalse(term_matches(j, ['Summer 2027'], False))
        j['terms'] = ['Summer 2027']
        self.assertTrue(term_matches(j, ['Summer 2027']))

    def test_known_wrong_year_is_not_unknown(self):
        j = {**job(), "title": "2026 Software Engineering Intern"}
        self.assertFalse(term_matches(j, ["Summer 2027"]))

    def test_fingerprint_location_and_season(self):
        self.assertNotEqual(fingerprint(job()), fingerprint({**job(), 'location': 'New York, NY'}))
        self.assertNotEqual(fingerprint(job()), fingerprint(job(terms=['Summer 2027'])))

    def test_old_norm_does_not_hide_new_season(self):
        j = job('simplify:new', agg=True, terms=['Summer 2027'])
        seen = {watcher.norm_key(j)}
        self.assertEqual(watcher.select_new([j], seen, {}, 100), [j])

    def test_same_url_cross_source_dedup(self):
        j = job()
        duplicate = {**j, 'id': 'simplify:456', 'agg': True}
        self.assertEqual(watcher.select_new([j, duplicate], set(), {}, 100), [j])

    def test_fuzzy_expiry_and_existing_history_migration(self):
        j = job('jobright:456', agg=True)
        ledger = {'fingerprints': {fingerprint(j): 0}}
        self.assertEqual(watcher.select_new([j], set(), ledger, 31 * 86400), [j])
        old = job()
        j['url'] = 'https://jobright.ai/jobs/info/456'
        self.assertEqual(watcher.select_new([old, j], {old['id']}, {}, 100), [])

    def test_corrupt_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'seen.json'
            path.write_text('{')
            with self.assertRaises(json.JSONDecodeError):
                load_json(path, [])


class CategoryTests(unittest.TestCase):
    TERMS = {
        'quant': ['quantitative', 'quant developer', 'quant researcher', 'quant trading',
                  'trading', 'algo trading'],
        'general': ['software', 'machine learning'],
    }

    def test_quant_only_title(self):
        j = job(title='Quantitative Trading Intern')
        self.assertEqual(categorize(j, self.TERMS), ['quant'])

    def test_general_only_title(self):
        j = job(title='Software Engineering Intern')
        self.assertEqual(categorize(j, self.TERMS), ['general'])

    def test_matches_both(self):
        j = job(title='Quantitative Software Engineer Intern')
        self.assertEqual(categorize(j, self.TERMS), ['general', 'quant'])

    def test_matches_neither_defaults_to_general(self):
        j = job(title='Product Management Intern')
        self.assertEqual(categorize(j, self.TERMS), ['general'])

    def test_discover_attaches_categories(self):
        cfg = {
            'companies': [{'name': 'QuantCo', 'ats': 'greenhouse', 'board': 'quantco'}],
            'include_keywords': ['intern'], 'exclude_keywords': [],
            'exclude_locations': [], 'terms': [],
            'simplify': {'enabled': False}, 'jobright': {'enabled': False},
            'category_terms': self.TERMS,
        }
        feed = [{'id': 'greenhouse:quantco:1', 'title': 'Quant Trading Intern',
                 'location': 'NYC', 'url': 'https://boards.greenhouse.io/quantco/jobs/1'}]
        with patch.object(watcher, 'ATS_FETCHERS', {'greenhouse': lambda org: feed}):
            [found] = watcher.discover(cfg)
        self.assertEqual(found['categories'], ['quant'])


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.patch = patch.multiple(watcher, ROOT=self.root, CONFIG_PATH=self.root/'config.json',
                                    SEEN_PATH=self.root/'seen.json')
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.cfg = {'companies': [], 'simplify': {'enabled': False}}
        (self.root/'config.json').write_text(json.dumps(self.cfg))

    def test_dry_run_unchanged_even_with_credentials(self):
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        with patch.dict(os.environ, {'SMTP_USER': 'me@example.com', 'SMTP_PASS': 'x'}, clear=True), \
             patch.object(watcher, 'discover', return_value=[job()]), \
             patch.object(watcher, 'notify_email') as send:
            self.assertEqual(watcher.main(['--dry-run']), 0)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        send.assert_not_called()

    def test_no_credentials_implies_dry_run(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(watcher, 'discover', return_value=[job()]):
            watcher.main([])
        self.assertFalse((self.root/'seen.json').exists())

    def test_destination_retry_survives_transient_failure(self):
        import smtplib
        cfg = self.cfg
        j = job()
        with patch.dict(os.environ, {'SMTP_USER': 'me@example.com', 'SMTP_PASS': 'x'}, clear=True), \
             patch.object(watcher, 'discover', side_effect=[[j], []]), \
             patch.object(watcher, 'notify_email', side_effect=[smtplib.SMTPException('down'), None]) as send:
            self.assertEqual(watcher.main([]), 1)
            ledger = load_json(self.root/'delivery_state.json', {})
            self.assertIn(j['id'], ledger['pending'])
            self.assertEqual(watcher.main([]), 0)
            self.assertEqual(send.call_count, 2)
        self.assertEqual(load_json(self.root/'delivery_state.json', {})['pending'], {})

    def test_email_and_notion_destinations_independent(self):
        import smtplib
        j = job()
        ledger = {'pending': {j['id']: {'job': j, 'destinations': ['email', 'notion']}}}
        with patch.object(watcher, 'notify_email', side_effect=smtplib.SMTPException('down')), \
             patch.object(notion, 'log_master', return_value=True):
            watcher.deliver(ledger, {}, lambda: None)
        # Notion succeeded and was removed; email failed and stayed queued.
        self.assertEqual(ledger['pending'][j['id']]['destinations'], ['email'])
        self.assertEqual(ledger['pending'][j['id']]['error'], 'SMTPException')

    def test_completed_destinations_not_repeated(self):
        j = job()
        ledger = {'pending': {j['id']: {'job': j, 'destinations': ['email', 'notion']}}}
        with patch.object(watcher, 'notify_email') as send, \
             patch.object(notion, 'log_master', side_effect=[False, True]):
            watcher.deliver(ledger, {}, lambda: None)
            watcher.deliver(ledger, {}, lambda: None)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(ledger['pending'], {})

    def test_source_failure_reported(self):
        watcher.SOURCE_HEALTH.clear()
        with patch.object(watcher.requests, 'get', return_value=Mock(status_code=404)):
            self.assertIsNone(watcher.get('https://example.invalid/jobs'))
        self.assertFalse(watcher.SOURCE_HEALTH['https://example.invalid/jobs']['ok'])

    def test_malformed_feed_schema_is_failure_not_empty_success(self):
        url = 'https://example.invalid/jobs'
        watcher.SOURCE_HEALTH[url] = {'last_success': 42, 'ok': True}
        with patch.object(watcher, 'get', return_value={'unexpected': []}):
            self.assertEqual(watcher.source_items(url, 'jobs'), [])
        self.assertFalse(watcher.SOURCE_HEALTH[url]['ok'])
        self.assertEqual(watcher.SOURCE_HEALTH[url]['last_success'], 42)

    def test_invalid_config_rejected(self):
        with self.assertRaises(ValueError):
            watcher.validate_config({'companies': [], 'dedup_days': -1})
        with self.assertRaises(ValueError):
            watcher.validate_config({'companies': [], 'category_terms': {'quant': 'not-a-list'}})

    def test_discord_destinations_stripped_from_ledger_on_load(self):
        (self.root/'delivery_state.json').write_text(json.dumps(
            {'pending': {'x': {'job': job(), 'destinations': ['discord:DISCORD_WEBHOOK_URL', 'notion']}}}))
        with patch.dict(os.environ, {'NOTION_TOKEN': 't', 'NOTION_PARENT_PAGE_ID': 'p'}, clear=True), \
             patch.object(watcher, 'discover', return_value=[]), \
             patch.object(notion, 'log_master', return_value=True), \
             patch.object(notion, 'run'):
            watcher.main([])
        ledger = load_json(self.root/'delivery_state.json', {})
        self.assertEqual(ledger['pending'], {})


class DigestTests(unittest.TestCase):
    def test_digest_groups_by_category_and_lists_both_for_dual_tagged(self):
        quant_job = job('q', title='Quant Trading Intern', categories=['quant'])
        general_job = job('g', title='SWE Intern', categories=['general'])
        both_job = job('b', title='Quant SWE Intern', categories=['quant', 'general'])
        body = watcher._digest_body([quant_job, general_job, both_job])
        self.assertIn('=== Quant (2) ===', body)
        self.assertIn('=== General (2) ===', body)

    def test_missing_categories_defaults_to_general_section(self):
        j = job()
        j.pop('categories', None)
        body = watcher._digest_body([j])
        self.assertIn('=== General (1) ===', body)
        self.assertNotIn('Quant', body)


class NotionTests(unittest.TestCase):
    def setUp(self):
        notion._PAGE_CACHE.clear()
        self.addCleanup(notion._PAGE_CACHE.clear)

    def test_saved_row_updated_in_place_with_reminder(self):
        j = job()
        saved = page(j)
        with patch.object(notion, '_notion', side_effect=[{'results': [saved]}, {'id': saved['id']}]) as api, \
             patch.object(notion, '_add_row') as add:
            result = notion._upsert_row('db', j, 'Applied')
        add.assert_not_called()
        self.assertEqual(result['id'], saved['id'])
        props = api.call_args.args[2]['properties']
        self.assertEqual(props['Status']['select']['name'], 'Applied')
        self.assertIn('start', props['Follow-up']['date'])

    def test_late_pin_does_not_downgrade_applied(self):
        j = job()
        with patch.object(notion, '_notion', return_value={'results': [page(j, 'Applied')]}) as api:
            notion._upsert_row('db', j, 'Saved')
        self.assertEqual(api.call_count, 1)

    def test_interview_not_downgraded_on_applied_link(self):
        j = job()
        with patch.object(notion, '_notion', return_value={'results': [page(j, 'Interview')]}) as api:
            notion._upsert_row('db', j, 'Applied')
        self.assertEqual(api.call_count, 1)

    def test_lookup_failure_never_creates_duplicate(self):
        with patch.object(notion, '_notion', return_value=None), patch.object(notion, '_add_row') as add:
            self.assertIsNone(notion._upsert_row('db', job(), 'Saved'))
        add.assert_not_called()

    def test_existing_tracking_parameters_reconcile(self):
        j = job()
        existing = page({**j, 'url': j['url'] + '?utm_source=discord'})
        with patch.object(notion, '_notion', return_value={'results': [existing]}), patch.object(notion, '_add_row') as add:
            self.assertIsNotNone(notion._upsert_row('db', j, 'Saved'))
        add.assert_not_called()

    def test_followups_only_for_due_applied(self):
        import copy
        due = page(job(), 'Applied')
        due['properties']['Follow-up'] = {'date': {'start': '2000-01-01'}}
        finished = copy.deepcopy(due)
        finished['properties']['Status']['select']['name'] = 'Offer'
        with patch.object(notion, '_pages', return_value=[due, finished]):
            self.assertEqual(notion._follow_ups('db'), ['SWE Intern'])

    def test_master_retry_finds_existing_page(self):
        with patch.object(notion, '_state', return_value={'master_db': 'db'}), \
             patch.object(notion, '_notion', return_value={'results': [page(job())]}), \
             patch.object(notion, '_add_row') as add:
            self.assertTrue(notion.log_master(job()))
        add.assert_not_called()

    def test_ambiguous_create_not_blindly_retried(self):
        with patch.dict(os.environ, {'NOTION_TOKEN': 'test'}), \
             patch.object(notion.requests, 'request', side_effect=requests.Timeout()) as api:
            self.assertIsNone(notion._notion('POST', '/pages', {}))
        self.assertEqual(api.call_count, 1)

    def test_reconcile_backfills_applied_on_and_follow_up(self):
        applied_no_date = page(job(), 'Applied')
        with patch.object(notion, '_pages', return_value=[applied_no_date]), \
             patch.object(notion, '_notion', return_value={'id': applied_no_date['id']}) as api:
            self.assertTrue(notion._reconcile_applied_status({'master_db': 'db'}, 14))
        props = api.call_args.args[2]['properties']
        self.assertIn('start', props['Applied On']['date'])
        self.assertIn('start', props['Follow-up']['date'])

    def test_reconcile_skips_rows_already_backfilled(self):
        already = page(job(), 'Applied')
        already['properties']['Applied On'] = {'date': {'start': '2026-01-01'}}
        with patch.object(notion, '_pages', return_value=[already]), \
             patch.object(notion, '_notion') as api:
            notion._reconcile_applied_status({'master_db': 'db'}, 14)
        api.assert_not_called()

    def test_cli_applied_reuses_url_parser_and_upserts(self):
        with patch.object(notion, '_state', return_value={'master_db': 'db'}), \
             patch.object(notion, '_save'), \
             patch.object(notion, '_parse_job_from_url', return_value=('Acme', 'SWE Intern', 'Remote')), \
             patch.object(notion, '_upsert_row', return_value={'id': 'p1'}) as upsert:
            code = notion._cli_applied('https://careers.acme.com/jobs/1')
        self.assertEqual(code, 0)
        job_arg = upsert.call_args.args[1]
        self.assertEqual(job_arg['company'], 'Acme')
        self.assertEqual(upsert.call_args.args[2], 'Applied')


if __name__ == '__main__':
    unittest.main()
