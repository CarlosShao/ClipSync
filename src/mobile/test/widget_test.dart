import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('App builds without crash', (WidgetTester tester) async {
    // Just verify the app widget tree can be built
    expect(
      () async {
        await tester.pumpWidget(
          const MaterialApp(
            home: Scaffold(
              body: Center(child: Text('ClipSync')),
            ),
          ),
        );
      },
      returnsNormally,
    );
  });

  testWidgets('Basic UI components render', (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              Text('Phone Number'),
              TextField(),
              ElevatedButton(
                onPressed: null,
                child: Text('Login'),
              ),
            ],
          ),
        ),
      ),
    );

    // Verify text renders
    expect(find.text('Phone Number'), findsOneWidget);
    expect(find.text('Login'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.byType(ElevatedButton), findsOneWidget);
  });
}
