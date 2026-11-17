-- Forma de pagamento "cheque" (a empresa também paga com cheque, além de dinheiro e cartão).
alter type public.forma_pagamento add value if not exists 'cheque';
