-- Keep a calendar date independently from an optional appointment time.
-- Existing timestamps remain intact; missing historical dates are not invented.
alter table public.orders add column pickup_date date;
alter table public.order_stops add column planned_date date;

update public.orders set pickup_date = (pickup_at at time zone 'Europe/Oslo')::date
where pickup_at is not null;
update public.order_stops set planned_date = (planned_at at time zone 'Europe/Oslo')::date
where planned_at is not null;

comment on column public.orders.pickup_date is 'Pickup calendar date in Europe/Oslo. Required by order entry; pickup_at remains null when no clock time is agreed.';
comment on column public.order_stops.planned_date is 'Calendar date in Europe/Oslo, independent of the optional planned_at timestamp.';
